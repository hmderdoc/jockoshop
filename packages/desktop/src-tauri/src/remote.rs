//! Uploading a finished piece to a board, over FTP.
//!
//! A browser is not allowed to open a socket, so this is the one part of
//! "upload to my BBS" that cannot live in the web app. The shape of a
//! connection and the path arithmetic are in packages/core/src/remote.ts; this
//! is only the wire.
//!
//! Every command connects, does its one job and quits. Holding a session open
//! would save a second per action, at the price of a socket that is dead after
//! the laptop sleeps and a pool to notice — and the whole job here is "list a
//! directory, send a file". Reconnecting is the cheaper trade.
//!
//! Explicit FTPS (`AUTH TLS`) is worth the dependency: Synchronet's own FTP
//! server offers it, and without it the password crosses the internet in the
//! clear.

use std::io::Cursor;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use suppaftp::list::ListParser;
use suppaftp::native_tls::TlsConnector as NativeTls;
use suppaftp::types::{FileType, FtpError, FtpResult};
use suppaftp::{Mode, NativeTlsConnector, NativeTlsFtpStream};

/// Long enough for a board on a slow link, short enough that a wrong address
/// fails while the user is still looking at the dialog.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The wait for one reply. Generous: the 226 that ends an upload arrives only
/// once the server has written the whole file.
const IO_TIMEOUT: Duration = Duration::from_secs(45);

/// The part of a connection this side needs. The rest (name, id, remembered
/// password) is the app's business.
#[derive(Debug, Clone, Deserialize)]
pub struct Profile {
    host: String,
    port: u16,
    user: String,
    secure: bool,
    passive: bool,
}

#[derive(Debug, Serialize)]
pub struct Entry {
    name: String,
    /// "file", "dir" or "link"
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    /// ms since the epoch
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// where the server says we are, which is not always what we asked for
    path: String,
    entries: Vec<Entry>,
    /// the server would only name the entries, not describe them
    names_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// the board's greeting, so the user can see they reached the right one
    welcome: String,
    path: String,
    /// whether the control connection ended up encrypted
    secure: bool,
    /// true when the server advertises AUTH TLS, so the dialog can suggest it
    offers_tls: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    /// bytes written, left out entirely when nothing was sent because the name
    /// was taken — so the app sees `undefined`, not the `null` serde would
    /// otherwise emit and an `=== undefined` check would miss
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
    /// a file of that name was already there
    existed: bool,
}

/// A socket with timeouts on it, so nothing waits forever.
fn dial(addr: SocketAddr) -> FtpResult<TcpStream> {
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(FtpError::ConnectionError)?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(FtpError::ConnectionError)?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(FtpError::ConnectionError)?;
    Ok(stream)
}

/// The first address the host resolves to. Its own error, because "no such
/// host" is the most common thing to get wrong and deserves saying plainly.
fn resolve(p: &Profile) -> Result<SocketAddr, String> {
    let host = p.host.trim();
    (host, p.port)
        .to_socket_addrs()
        .map_err(|e| format!("Could not look up {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("{host} has no address."))
}

/// Connect, optionally start TLS, log in, and switch to binary. ANSI art is
/// binary: ASCII mode would rewrite every line ending and corrupt the SAUCE.
fn open(p: &Profile, password: &str) -> Result<NativeTlsFtpStream, String> {
    let addr = resolve(p)?;
    let where_ = format!("{}:{}", p.host.trim(), p.port);
    let mut ftp = NativeTlsFtpStream::connect_with_stream(dial(addr).map_err(|e| format!("{where_}: {e}"))?)
        .map_err(|e| format!("{where_}: {e}"))?
        .passive_stream_builder(dial);
    if p.secure {
        let tls = NativeTls::new().map_err(|e| format!("TLS is not available on this machine: {e}"))?;
        ftp = ftp
            .into_secure(NativeTlsConnector::from(tls), p.host.trim())
            .map_err(|e| format!("{where_}: could not start TLS — {e}. Some boards have FTPS turned off; try it unencrypted."))?;
    }
    // PASV cannot carry an IPv6 address; EPSV is what RFC 2428 added for it
    ftp.set_mode(match (p.passive, addr.is_ipv6()) {
        (false, _) => Mode::Active,
        (true, true) => Mode::ExtendedPassive,
        (true, false) => Mode::Passive,
    });
    ftp.login(p.user.trim(), password)
        .map_err(|e| format!("{} could not log in as {}: {e}", where_, p.user.trim()))?;
    ftp.transfer_type(FileType::Binary).map_err(|e| format!("{where_}: {e}"))?;
    Ok(ftp)
}

/// Best effort QUIT: the work is already done, and a board that drops the
/// connection instead of answering is not an error worth reporting.
fn bye(mut ftp: NativeTlsFtpStream) {
    let _ = ftp.quit();
}

fn millis(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// One line of LIST output. Unix format first — that is what Synchronet and
/// every other board emits — then DOS, for the ones running on Windows.
fn parse_line(line: &str) -> Option<Entry> {
    let file = ListParser::parse_posix(line).or_else(|_| ListParser::parse_dos(line)).ok()?;
    let name = file.name().to_string();
    if name == "." || name == ".." || name.is_empty() {
        return None;
    }
    let kind = if file.is_directory() { "dir" } else if file.is_symlink() { "link" } else { "file" };
    Some(Entry {
        // a size on a directory means nothing, so it is not reported
        size: if file.is_directory() { None } else { Some(file.size() as u64) },
        modified: millis(file.modified()),
        name,
        kind,
    })
}

fn list_here(ftp: &mut NativeTlsFtpStream, path: &str) -> Result<Listing, String> {
    ftp.cwd(path).map_err(|e| format!("Could not open {path}: {e}"))?;
    let here = ftp.pwd().unwrap_or_else(|_| path.to_string());
    let lines = ftp.list(None).map_err(|e| format!("Could not list {here}: {e}"))?;
    let entries: Vec<Entry> = lines.iter().filter_map(|l| parse_line(l)).collect();
    // LIST has no standard format. When the server answered but in a dialect
    // neither parser knows, NLST at least gives the names — enough to see the
    // file landed, even if the list cannot say which entries are directories.
    if entries.is_empty() && !lines.is_empty() {
        let names = ftp.nlst(None).map_err(|e| format!("Could not list {here}: {e}"))?;
        return Ok(Listing {
            entries: names
                .iter()
                .map(|n| n.rsplit('/').next().unwrap_or(n).to_string())
                .filter(|n| !n.is_empty() && n != "." && n != "..")
                .map(|name| Entry { name, kind: "file", size: None, modified: None })
                .collect(),
            path: here,
            names_only: true,
        });
    }
    Ok(Listing { path: here, entries, names_only: false })
}

/// Reach the board and say what we found, without changing anything.
#[tauri::command]
pub async fn remote_probe(profile: Profile, password: String) -> Result<Probe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let addr = resolve(&profile)?;
        let where_ = format!("{}:{}", profile.host.trim(), profile.port);
        // FEAT before logging in: it is allowed there, and it is how we learn
        // whether a board we are talking to in the clear could have been encrypted
        let mut plain = NativeTlsFtpStream::connect_with_stream(dial(addr).map_err(|e| format!("{where_}: {e}"))?)
            .map_err(|e| format!("{where_}: {e}"))?;
        let welcome = plain.get_welcome_msg().unwrap_or_default().to_string();
        let offers_tls = plain.feat().map(|f| f.contains_key("AUTH")).unwrap_or(false);
        bye(plain);

        let mut ftp = open(&profile, &password)?;
        let path = ftp.pwd().unwrap_or_else(|_| "/".into());
        bye(ftp);
        Ok(Probe { welcome: welcome.trim().to_string(), path, secure: profile.secure, offers_tls })
    })
    .await
    .map_err(|e| format!("{e}"))?
}

/// What is in one directory.
#[tauri::command]
pub async fn remote_list(profile: Profile, password: String, path: String) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut ftp = open(&profile, &password)?;
        let out = list_here(&mut ftp, &path);
        bye(ftp);
        out
    })
    .await
    .map_err(|e| format!("{e}"))?
}

/// Send one file. With `overwrite` false, a name already on the server is
/// reported back rather than replaced, so the app can ask first.
#[tauri::command]
pub async fn remote_upload(
    profile: Profile, password: String, path: String, name: String, data: Vec<u8>, overwrite: bool,
) -> Result<Upload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut ftp = open(&profile, &password)?;
        let result = (|| -> Result<Upload, String> {
            ftp.cwd(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
            // SIZE is the cheapest "is it there"; a server that will not answer
            // it just means the check does not fire, and STOR behaves as always
            let existed = ftp.size(&name).is_ok();
            if existed && !overwrite {
                return Ok(Upload { bytes: None, existed });
            }
            let mut body = Cursor::new(data);
            let bytes = ftp.put_file(&name, &mut body).map_err(|e| format!("Could not write {name}: {e}"))?;
            Ok(Upload { bytes: Some(bytes), existed })
        })();
        bye(ftp);
        result
    })
    .await
    .map_err(|e| format!("{e}"))?
}

/// A stand-in for a board, so the wire is tested and not just the types.
///
/// It answers what Synchronet's ftpsrvr.cpp answers, in the same order and the
/// same dialect — a Unix LIST, `AUTH TLS` in FEAT, SIZE for the existence
/// check — and keeps whatever is uploaded so a test can compare the bytes.
#[cfg(test)]
mod board {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;

    #[derive(Default)]
    pub struct State {
        /// name -> contents, as uploaded
        pub files: HashMap<String, Vec<u8>>,
        /// every command line the client sent, in order
        pub log: Vec<String>,
    }

    pub struct Board {
        pub addr: SocketAddr,
        pub state: Arc<Mutex<State>>,
    }

    /// `listing` is what LIST returns, one line per entry, already in the
    /// server's dialect. `files` are the names SIZE should admit to.
    pub fn start(listing: Vec<String>, files: Vec<&str>) -> Board {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let state = Arc::new(Mutex::new(State::default()));
        for f in files {
            state.lock().unwrap().files.insert(f.to_string(), b"old".to_vec());
        }
        let shared = Arc::clone(&state);
        thread::spawn(move || {
            // one connection at a time is enough: every command here connects,
            // does its job and quits
            for client in listener.incoming() {
                match client {
                    Ok(c) => serve(c, &shared, &listing),
                    Err(_) => break,
                }
            }
        });
        Board { addr, state }
    }

    fn serve(control: TcpStream, state: &Arc<Mutex<State>>, listing: &[String]) {
        let mut out = control.try_clone().expect("clone");
        let mut lines = BufReader::new(control);
        let say = |out: &mut TcpStream, text: &str| {
            let _ = out.write_all(format!("{text}\r\n").as_bytes());
        };
        say(&mut out, "220 jockoshop test board");
        // the passive listener, made by PASV and consumed by the next transfer
        let mut pending: Option<TcpListener> = None;
        let mut who = String::new();
        loop {
            let mut line = String::new();
            match lines.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let line = line.trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            state.lock().unwrap().log.push(line.clone());
            let (verb, arg) = match line.split_once(' ') {
                Some((v, a)) => (v.to_uppercase(), a.trim().to_string()),
                None => (line.to_uppercase(), String::new()),
            };
            match verb.as_str() {
                "USER" => {
                    who = arg;
                    say(&mut out, "331 Password required");
                }
                // one name the board refuses, so the failure path is tested too
                "PASS" => if who == "nosuchuser" { say(&mut out, "530 Login incorrect") } else { say(&mut out, "230 User logged in") },
                "FEAT" => {
                    // Synchronet's own FEAT block, trimmed to what we read
                    for l in ["211-The following additional features are supported:", " MDTM", " SIZE", " REST STREAM", " AUTH TLS", " PBSZ", " PROT", "211 End"] {
                        say(&mut out, l);
                    }
                }
                "TYPE" => say(&mut out, "200 Type set to I"),
                "PWD" | "XPWD" => say(&mut out, "257 \"/art\" is current directory"),
                "CWD" | "XCWD" => {
                    if arg == "/nope" { say(&mut out, "550 No such directory") } else { say(&mut out, "250 CWD command successful") }
                }
                "SIZE" => match state.lock().unwrap().files.get(&arg) {
                    Some(b) => say(&mut out, &format!("213 {}", b.len())),
                    None => say(&mut out, "550 No such file"),
                },
                "PASV" => {
                    let data = TcpListener::bind("127.0.0.1:0").expect("data bind");
                    let port = data.local_addr().expect("data addr").port();
                    pending = Some(data);
                    say(&mut out, &format!("227 Entering Passive Mode (127,0,0,1,{},{})", port >> 8, port & 0xff));
                }
                "LIST" | "NLST" => {
                    say(&mut out, "150 Opening BINARY mode data connection");
                    if let Some(data) = pending.take() {
                        if let Ok((mut sock, _)) = data.accept() {
                            for l in listing {
                                let _ = sock.write_all(format!("{l}\r\n").as_bytes());
                            }
                            // closing the data connection is what ends the listing
                            drop(sock);
                        }
                    }
                    say(&mut out, "226 Transfer complete");
                }
                "STOR" => {
                    say(&mut out, "150 Opening BINARY mode data connection");
                    let mut body = Vec::new();
                    if let Some(data) = pending.take() {
                        if let Ok((mut sock, _)) = data.accept() {
                            let _ = sock.read_to_end(&mut body);
                        }
                    }
                    state.lock().unwrap().files.insert(arg, body);
                    say(&mut out, "226 Transfer complete");
                }
                "QUIT" => {
                    say(&mut out, "221 Goodbye");
                    return;
                }
                _ => say(&mut out, "502 Command not implemented"),
            }
        }
    }
}

#[cfg(test)]
mod wire {
    use super::*;

    /// Exactly the shape Synchronet prints, single-digit day included.
    fn synchronet_listing() -> Vec<String> {
        vec![
            "drwxrwxrwx   1 sysop    sysop          1024 Sep 27 11:04 packs".to_string(),
            "-rw-rw-rw-   1 sysop    sysop          4096 Sep 27 11:04 killer.ans".to_string(),
            "-rw-rw-rw-   1 sysop    sysop           128 Sep  5 09:00 old.ans".to_string(),
        ]
    }

    fn profile(addr: std::net::SocketAddr) -> Profile {
        Profile { host: addr.ip().to_string(), port: addr.port(), user: "sysop".into(), secure: false, passive: true }
    }

    #[tokio::test]
    async fn lists_a_directory() {
        let board = board::start(synchronet_listing(), vec![]);
        let got = remote_list(profile(board.addr), "pw".into(), "/art".into()).await.expect("list");
        assert_eq!(got.path, "/art", "the path comes from the server's PWD, not from what we asked");
        assert!(!got.names_only);
        let names: Vec<&str> = got.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["packs", "killer.ans", "old.ans"]);
        assert_eq!(got.entries[0].kind, "dir");
        assert_eq!(got.entries[1].size, Some(4096));
        // binary, or ASCII mode would rewrite the line endings and break SAUCE
        assert!(board.state.lock().unwrap().log.iter().any(|c| c == "TYPE I"), "the transfer must be binary");
    }

    #[tokio::test]
    async fn a_directory_that_is_not_there_says_so() {
        let board = board::start(synchronet_listing(), vec![]);
        let err = remote_list(profile(board.addr), "pw".into(), "/nope".into()).await.unwrap_err();
        assert!(err.contains("/nope"), "the message names the directory: {err}");
    }

    #[tokio::test]
    async fn falls_back_to_nlst_when_the_listing_is_a_dialect_we_cannot_read() {
        // a server answering in something neither parser knows
        let board = board::start(vec!["KILLER.ANS;1  4096  BLOCKS".to_string()], vec![]);
        let got = remote_list(profile(board.addr), "pw".into(), "/art".into()).await.expect("list");
        assert!(got.names_only, "the names came from NLST, so the dialog must not claim sizes");
        assert_eq!(got.entries.len(), 1);
        assert!(board.state.lock().unwrap().log.iter().any(|c| c.starts_with("NLST")));
    }

    #[tokio::test]
    async fn uploads_the_bytes_it_was_given() {
        let board = board::start(synchronet_listing(), vec![]);
        let art = b"\x1b[0;36m\xdb\xdb\xdb\r\n".to_vec();
        let out = remote_upload(profile(board.addr), "pw".into(), "/art".into(), "new.ans".into(), art.clone(), false)
            .await.expect("upload");
        assert_eq!(out.bytes, Some(art.len() as u64));
        assert!(!out.existed);
        assert_eq!(board.state.lock().unwrap().files.get("new.ans"), Some(&art), "the board got the bytes unchanged");
    }

    #[tokio::test]
    async fn will_not_replace_a_file_unless_told_to() {
        let board = board::start(synchronet_listing(), vec!["killer.ans"]);
        let p = profile(board.addr);
        let blocked = remote_upload(p.clone(), "pw".into(), "/art".into(), "killer.ans".into(), b"new".to_vec(), false)
            .await.expect("upload");
        assert_eq!(blocked.bytes, None, "nothing was sent");
        assert!(blocked.existed);
        assert_eq!(board.state.lock().unwrap().files.get("killer.ans").map(|b| b.as_slice()), Some(&b"old"[..]), "the file on the board is untouched");

        let replaced = remote_upload(p, "pw".into(), "/art".into(), "killer.ans".into(), b"new".to_vec(), true)
            .await.expect("upload");
        assert_eq!(replaced.bytes, Some(3));
        assert!(replaced.existed, "the caller is told it overwrote something");
        assert_eq!(board.state.lock().unwrap().files.get("killer.ans").map(|b| b.as_slice()), Some(&b"new"[..]));
    }

    #[tokio::test]
    async fn probe_reports_the_greeting_and_that_tls_is_on_offer() {
        let board = board::start(synchronet_listing(), vec![]);
        let got = remote_probe(profile(board.addr), "pw".into()).await.expect("probe");
        assert!(got.welcome.contains("jockoshop test board"), "the greeting is shown so you can see which board answered: {}", got.welcome);
        assert_eq!(got.path, "/art");
        assert!(!got.secure);
        // the whole point: an unencrypted login to a board that offers AUTH TLS
        // is a choice the user should be told about
        assert!(got.offers_tls);
    }

    #[tokio::test]
    async fn a_refused_login_names_the_user_and_the_board() {
        let board = board::start(synchronet_listing(), vec![]);
        let mut p = profile(board.addr);
        p.user = "nosuchuser".into();
        let err = remote_list(p, "pw".into(), "/art".into()).await.unwrap_err();
        assert!(err.contains("nosuchuser"), "the message says who could not get in: {err}");
        assert!(err.contains("127.0.0.1"), "and which board refused: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_unix_listing() {
        // exactly what Synchronet's ftpsrvr.cpp prints for a directory
        let dir = parse_line("drwxrwxrwx   1 sysop    sysop          1024 Sep 27 11:04 artpacks").unwrap();
        assert_eq!(dir.name, "artpacks");
        assert_eq!(dir.kind, "dir");
        assert_eq!(dir.size, None, "a size on a directory means nothing");

        let file = parse_line("-rw-rw-rw-   1 sysop    sysop          4096 Sep 27 11:04 killer.ans").unwrap();
        assert_eq!(file.name, "killer.ans");
        assert_eq!(file.kind, "file");
        assert_eq!(file.size, Some(4096));
    }

    #[test]
    fn reads_a_dos_listing() {
        let file = parse_line("09-27-26  11:04AM                 4096 killer.ans").unwrap();
        assert_eq!(file.name, "killer.ans");
        assert_eq!(file.kind, "file");
        assert_eq!(file.size, Some(4096));
    }

    #[test]
    fn keeps_spaces_and_single_digit_days() {
        // Synchronet pads the day with %2d, so single-digit days come through
        // as two spaces, and a name may have spaces of its own
        let file = parse_line("-rw-rw-rw-   1 sysop    sysop           128 Sep  5 09:00 my best piece.ans").unwrap();
        assert_eq!(file.name, "my best piece.ans");
        assert_eq!(file.size, Some(128));
    }

    #[test]
    fn drops_dot_entries_and_noise() {
        assert!(parse_line("drwxr-xr-x   2 sysop    sysop           512 Sep 27 11:04 .").is_none());
        assert!(parse_line("drwxr-xr-x   2 sysop    sysop           512 Sep 27 11:04 ..").is_none());
        assert!(parse_line("total 8").is_none(), "ls headers are not files");
        assert!(parse_line("").is_none());
    }

    #[test]
    fn a_symlink_is_its_own_kind() {
        // FTP will not say where a link goes, so it is shown but not followed
        let link = parse_line("lrwxrwxrwx   1 sysop    sysop             9 Sep 27 11:04 latest.ans").unwrap();
        assert_eq!(link.kind, "link");
    }

    /// The names here are the app's side of the contract (packages/app/src/remote.ts).
    /// Renaming a field silently breaks the dialog, so they are pinned.
    #[test]
    fn the_json_is_what_the_app_reads() {
        let listing = Listing {
            path: "/art".into(),
            entries: vec![Entry { name: "killer.ans".into(), kind: "file", size: Some(4096), modified: Some(1_700_000_000_000) }],
            names_only: true,
        };
        let json = serde_json::to_value(&listing).unwrap();
        assert_eq!(json["namesOnly"], true, "camelCase, as the TypeScript side spells it");
        assert_eq!(json["entries"][0]["type"], "file", "`type`, not `kind`");
        assert_eq!(json["entries"][0]["size"], 4096);

        // a size that is absent must be absent, not null: the dialog shows
        // nothing for a missing size and "0 bytes" for a real zero
        let bare = serde_json::to_value(Entry { name: "packs".into(), kind: "dir", size: None, modified: None }).unwrap();
        assert!(bare.get("size").is_none() && bare.get("modified").is_none());

        // and the one that decides whether an upload happened
        let blocked = serde_json::to_value(Upload { bytes: None, existed: true }).unwrap();
        assert!(blocked.get("bytes").is_none(), "an upload that did not happen leaves `bytes` out, so `=== undefined` holds");
        let sent = serde_json::to_value(Upload { bytes: Some(0), existed: false }).unwrap();
        assert_eq!(sent["bytes"], 0, "an empty file is still a file that was sent");

        let probe = serde_json::to_value(Probe { welcome: "hi".into(), path: "/".into(), secure: false, offers_tls: true }).unwrap();
        assert_eq!(probe["offersTls"], true);
    }

    #[test]
    fn a_bad_host_says_so_before_any_socket() {
        let p = Profile {
            host: "no.such.host.invalid".into(), port: 21, user: "a".into(), secure: false, passive: true,
        };
        let err = resolve(&p).unwrap_err();
        assert!(err.contains("no.such.host.invalid"), "the message names the host: {err}");
    }
}
