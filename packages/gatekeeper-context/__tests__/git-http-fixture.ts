import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import {
  add,
  commit,
  init,
  packObjects,
  readCommit,
  readTree,
} from "isomorphic-git";

/** One deterministic smart-HTTP Git response set backed by a real packfile. */
export type GitHttpFixture = {
  advertisement: Uint8Array;
  commit: string;
  uploadPack: Uint8Array;
};

function packetLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
  const length = (body.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(length), body]);
}

async function collectTreeObjects(dir: string, treeOid: string): Promise<string[]> {
  const result = await readTree({ fs, dir, oid: treeOid });
  const nested = await Promise.all(result.tree
    .filter(entry => entry.type === "tree")
    .map(entry => collectTreeObjects(dir, entry.oid)));
  return [treeOid, ...result.tree
    .filter(entry => entry.type === "blob")
    .map(entry => entry.oid), ...nested.flat()];
}

/** Build a one-commit repository and its protocol-faithful upload-pack response. */
export async function buildGitHttpFixture(options: {
  body: string;
  filename: string;
  fixtureId: string;
}): Promise<GitHttpFixture> {
  const dir = `/tmp/context-git-http-fixture-${options.fixtureId}`;
  await fsp.mkdir(dir, { recursive: true });
  await init({ fs, dir, defaultBranch: "main" });
  await fsp.writeFile(`${dir}/${options.filename}`, options.body);
  await add({ fs, dir, filepath: options.filename });
  return commitGitHttpFixture(dir, 1_700_000_000);
}

/** Append one commit to an existing fixture repository and build the next fetch response. */
export async function updateGitHttpFixture(options: {
  body: string;
  filename: string;
  fixtureId: string;
}): Promise<GitHttpFixture> {
  const dir = `/tmp/context-git-http-fixture-${options.fixtureId}`;
  await fsp.writeFile(`${dir}/${options.filename}`, options.body);
  await add({ fs, dir, filepath: options.filename });
  return commitGitHttpFixture(dir, 1_700_000_001);
}

async function commitGitHttpFixture(dir: string, timestamp: number): Promise<GitHttpFixture> {
  const commitOid = await commit({
    fs,
    dir,
    message: "Context Git billing fixture",
    author: {
      name: "Context Fixture",
      email: "context-fixture@example.invalid",
      timestamp,
      timezoneOffset: 0,
    },
  });
  const { commit: commitObject } = await readCommit({ fs, dir, oid: commitOid });
  const objectIds = [commitOid, ...await collectTreeObjects(dir, commitObject.tree)];
  const { packfile } = await packObjects({ fs, dir, oids: objectIds });
  if (!packfile) throw new Error("Git fixture packfile was not created.");

  const advertisement = Buffer.concat([
    packetLine("# service=git-upload-pack\n"),
    Buffer.from("0000"),
    packetLine(
      `${commitOid} HEAD\0symref=HEAD:refs/heads/main side-band-64k ofs-delta shallow\n`,
    ),
    packetLine(`${commitOid} refs/heads/main\n`),
    Buffer.from("0000"),
  ]);
  const packPackets: Buffer[] = [
    packetLine(`shallow ${commitOid}\n`),
    packetLine("NAK\n"),
  ];
  for (let offset = 0; offset < packfile.length; offset += 60_000) {
    const chunk = packfile.slice(offset, offset + 60_000);
    packPackets.push(packetLine(Buffer.concat([Buffer.from([1]), Buffer.from(chunk)])));
  }
  packPackets.push(Buffer.from("0000"));
  return {
    advertisement,
    commit: commitOid,
    uploadPack: Buffer.concat(packPackets),
  };
}
