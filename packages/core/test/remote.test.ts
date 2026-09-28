import { describe, expect, it } from "vitest";
import {
  ANONYMOUS, FTP_PORT, type RemoteEntry, type RemoteListing,
  absolute, childPath, fileSize, findEntry, newProfile, parentPath, pathTrail, profileProblem, profileSummary,
  safeRemoteName, sortEntries,
} from "../src/index.js";

const listing = (...names: [string, RemoteEntry["type"]][]): RemoteListing =>
  ({ path: "/art", entries: names.map(([name, type]) => ({ name, type })) });

describe("remote paths", () => {
  it("spells a path the way a server wants it", () => {
    expect(absolute("")).toBe("/");
    expect(absolute("/")).toBe("/");
    expect(absolute("art")).toBe("/art");
    expect(absolute("/art/")).toBe("/art");
    expect(absolute("//art///packs//")).toBe("/art/packs");
  });

  it("applies .. and drops . so a typed path still names one place", () => {
    expect(absolute("/art/packs/..")).toBe("/art");
    expect(absolute("/art/./packs")).toBe("/art/packs");
    // ".." at the root cannot escape it
    expect(absolute("/../..")).toBe("/");
  });

  it("walks in and out", () => {
    expect(childPath("/art", "packs")).toBe("/art/packs");
    expect(childPath("/", "art")).toBe("/art");
    expect(parentPath("/art/packs")).toBe("/art");
    expect(parentPath("/art")).toBe("/");
    // the root has no parent, and going up from it must not throw or escape
    expect(parentPath("/")).toBe("/");
  });

  it("builds a trail that starts at the root", () => {
    expect(pathTrail("/art/packs")).toEqual([
      { name: "/", path: "/" },
      { name: "art", path: "/art" },
      { name: "packs", path: "/art/packs" },
    ]);
    expect(pathTrail("/")).toEqual([{ name: "/", path: "/" }]);
  });

  it("keeps a space in a directory name, because servers do", () => {
    expect(absolute("/art packs/new stuff")).toBe("/art packs/new stuff");
  });
});

describe("remote file names", () => {
  it("strips what would confuse a server or name another directory", () => {
    expect(safeRemoteName("killer.ans")).toBe("killer.ans");
    expect(safeRemoteName("art/killer.ans")).toBe("artkiller.ans");
    expect(safeRemoteName('bad"name*.ans')).toBe("badname.ans");
    expect(safeRemoteName("with\u0000nul.ans")).toBe("withnul.ans");
  });

  it("turns spaces into underscores and drops a leading dash", () => {
    // a leading dash reads as a flag to some servers' own ls
    expect(safeRemoteName("my best piece.ans")).toBe("my_best_piece.ans");
    expect(safeRemoteName("--rf.ans")).toBe("rf.ans");
  });

  it("never returns nothing to upload under", () => {
    expect(safeRemoteName("///")).toBe("art");
    expect(safeRemoteName("", "piece.ans")).toBe("piece.ans");
  });
});

describe("a connection", () => {
  it("says what is missing before anything is dialled", () => {
    const p = newProfile();
    expect(profileProblem(p)).toMatch(/address/);
    p.host = "bbs.example.org";
    expect(profileProblem(p)).toMatch(new RegExp(ANONYMOUS));
    p.user = ANONYMOUS;
    expect(profileProblem(p)).toBeNull();
  });

  it("rejects a host that is not one, and a port that is not a port", () => {
    const p = { ...newProfile(), host: "bbs.example.org", user: ANONYMOUS };
    expect(profileProblem({ ...p, host: "http://bbs.example.org/" })).toMatch(/not a host/);
    expect(profileProblem({ ...p, port: 0 })).toMatch(/1 to 65535/);
    expect(profileProblem({ ...p, port: 70000 })).toMatch(/1 to 65535/);
    expect(profileProblem({ ...p, port: 1.5 })).toMatch(/1 to 65535/);
  });

  it("reads back as one line, hiding the default port", () => {
    const p = { ...newProfile(), host: "bbs.example.org", user: "sysop", dir: "/art/" };
    expect(profileSummary(p)).toBe("ftp://sysop@bbs.example.org/art");
    expect(profileSummary({ ...p, secure: true })).toBe("ftps://sysop@bbs.example.org/art");
    expect(profileSummary({ ...p, port: 2121 })).toBe("ftp://sysop@bbs.example.org:2121/art");
    expect(FTP_PORT).toBe(21);
  });

  it("gives every new connection its own id, even made in one millisecond", () => {
    // 12 bits of randomness collided about a quarter of the time here, which
    // would have silently overwritten a saved connection
    const ids = new Set(Array.from({ length: 2000 }, () => newProfile().id));
    expect(ids.size).toBe(2000);
  });
});

describe("a listing", () => {
  it("puts directories first, then names in a human order", () => {
    const got = sortEntries(listing(
      ["piece10.ans", "file"], ["piece2.ans", "file"], ["zdir", "dir"], ["Art", "dir"],
    ).entries);
    expect(got.map((e) => e.name)).toEqual(["Art", "zdir", "piece2.ans", "piece10.ans"]);
  });

  it("finds a name the way a DOS board would, ignoring case", () => {
    const l = listing(["KILLER.ANS", "file"]);
    expect(findEntry(l, "killer.ans")?.name).toBe("KILLER.ANS");
    expect(findEntry(l, "other.ans")).toBeUndefined();
  });
});

describe("sizes", () => {
  it("reads the way a file list does", () => {
    expect(fileSize(0)).toBe("0 bytes");
    expect(fileSize(812)).toBe("812 bytes");
    expect(fileSize(4096)).toBe("4.0 KB");
    expect(fileSize(64000)).toBe("63 KB");   // 62.5 rounds up, like every file list
    expect(fileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
