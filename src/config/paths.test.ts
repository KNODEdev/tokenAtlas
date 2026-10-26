import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  AtlasSnapshotPoolLocationError,
  ATLAS_INDEX_SNAPSHOT_DIRECTORY,
  atlasIndexSnapshotPool,
} from "./paths";

describe("Atlas snapshot paths", () => {
  test("stores index snapshots beside the active local database by default", () => {
    const env = {
      OneDrive: "H:/OneDrive",
    };
    const database = "C:/Users/example/.tokenatlas/atlas.sqlite";

    expect(atlasIndexSnapshotPool(database, env)).toBe(path.resolve(
      path.dirname(database),
      ATLAS_INDEX_SNAPSHOT_DIRECTORY,
    ));
  });

  test("accepts a configured local directory and rejects OneDrive or archive paths", () => {
    const database = "C:/Users/example/.tokenatlas/atlas.sqlite";
    expect(atlasIndexSnapshotPool(database, {
      OneDrive: "H:/OneDrive",
      TOKENATLAS_SNAPSHOT_DIR: "D:/tokenAtlas-snapshots",
    })).toBe(path.resolve("D:/tokenAtlas-snapshots"));

    for (const configured of [
      "H:/OneDrive/tokenAtlas-snapshots",
      "D:/shared-archive/atlas-index-snapshots",
    ]) {
      expect(() => atlasIndexSnapshotPool(database, {
        OneDrive: "H:/OneDrive",
        TOKENATLAS_ARCHIVE: "D:/shared-archive",
        TOKENATLAS_SNAPSHOT_DIR: configured,
      })).toThrow(AtlasSnapshotPoolLocationError);
    }

    expect(() => atlasIndexSnapshotPool(database, {
      OneDrive: "H:/OneDrive",
      TOKENATLAS_SNAPSHOT_DIR: database,
    })).toThrow(AtlasSnapshotPoolLocationError);
  });
});
