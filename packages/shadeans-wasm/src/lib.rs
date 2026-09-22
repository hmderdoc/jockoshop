//! shadeans as a WebAssembly module. The shadeans sources are compiled in
//! unmodified from a pinned checkout (see scripts/build-shadeans.mjs), so the
//! editor and the shadeans CLI run the same algorithm.
//!
//! Plain C ABI, no wasm-bindgen: the caller allocates with `kd_alloc`, copies
//! RGBA pixels and an options block in, and reads cells back out.
#![allow(dead_code)]

#[path = "../vendor/shadeans/src/color.rs"]
mod color;
#[path = "../vendor/shadeans/src/convert.rs"]
mod convert;
#[path = "../vendor/shadeans/src/font.rs"]
mod font;
#[path = "../vendor/shadeans/src/source.rs"]
mod source;

/// Bytes per cell in the result: ch, fg, bg, has_rgb, fg r g b, bg r g b.
pub const CELL_BYTES: usize = 10;
/// Number of f32 values in the options block.
pub const OPTION_COUNT: usize = 13;

#[no_mangle]
pub extern "C" fn kd_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `kd_alloc`/`kd_convert` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn kd_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn kd_rows_for_aspect(width: u32, height: u32, cols: u32) -> u32 {
    source::rows_for_aspect(width, height, cols as usize) as u32
}

/// Options block, all f32 (flags are 0/1; NaN for auto_chroma / local_contrast
/// means "shadeans' default for this mode"):
///   0 lambda  1 ice  2 blocks  3 coherence  4 sweeps  5 truecolor
///   6 auto_levels  7 auto_chroma  8 equalize  9 local_contrast
///   10 contrast  11 saturation  12 smooth
///
/// Returns `cols * rows * CELL_BYTES` bytes, to be released with `kd_free`.
///
/// # Safety
/// `rgba` must point to `width * height * 4` bytes and `options` to
/// `OPTION_COUNT` f32 values.
#[no_mangle]
pub unsafe extern "C" fn kd_convert(
    rgba: *const u8, width: u32, height: u32, cols: u32, rows: u32, options: *const f32,
) -> *mut u8 {
    let pixels = std::slice::from_raw_parts(rgba, (width * height * 4) as usize).to_vec();
    let o = std::slice::from_raw_parts(options, OPTION_COUNT);
    let (cols, rows) = (cols as usize, rows as usize);
    let truecolor = o[5] != 0.0;

    let opts = convert::Options {
        lambda: o[0],
        ice: o[1] != 0.0,
        glyphs: if o[2] != 0.0 { convert::GlyphSet::Blocks } else { convert::GlyphSet::Shaded },
        coherence: o[3],
        sweeps: o[4] as u32,
        truecolor,
    };
    let prep = source::Prep {
        auto_levels: o[6] != 0.0,
        auto_chroma: if o[7].is_nan() { if truecolor { 0.0 } else { 0.16 } } else { o[7] },
        equalize: o[8],
        local_contrast: if o[9].is_nan() { if truecolor { 0.0 } else { 0.5 } } else { o[9] },
        contrast: o[10],
        saturation: o[11],
        smooth: o[12] as u32,
    };

    let image = image::RgbaImage::from_raw(width, height, pixels).expect("pixel buffer size");
    let src = source::prepare(&image, cols, rows, &prep);
    let cells = convert::convert(&src, cols, rows, &color::Palette::vga(), &opts);

    let mut out = Vec::<u8>::with_capacity(cells.len() * CELL_BYTES);
    for c in &cells {
        let (has, f, b) = match c.rgb {
            Some((f, b)) => (1, f, b),
            None => (0, [0; 3], [0; 3]),
        };
        out.extend_from_slice(&[c.ch, c.fg, c.bg, has, f[0], f[1], f[2], b[0], b[1], b[2]]);
    }
    let ptr = out.as_mut_ptr();
    std::mem::forget(out);
    ptr
}
