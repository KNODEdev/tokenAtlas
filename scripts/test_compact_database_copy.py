import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("compact_copy", Path(__file__).with_name("compact-database-copy.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CompactDatabaseCopyTests(unittest.TestCase):
    def test_gapped_hidden_ids_relationships_blobs_generated_columns_and_triggers(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.sqlite", Path(directory) / "copy.sqlite"
            with closing(sqlite3.connect(source)) as db:
                db.executescript("""
                  CREATE TABLE ratelimit(ts TEXT, used REAL, payload BLOB);
                  INSERT INTO ratelimit(rowid,ts,used,payload) VALUES(9,'week-one',22,x'00ff'),(700,'week-two',25,x'fe');
                  CREATE TABLE ratelimit_note(ratelimit_rowid INTEGER PRIMARY KEY,note TEXT);
                  INSERT INTO ratelimit_note VALUES(9,'one'),(700,'two');
                  CREATE TABLE source(id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER, twice INTEGER GENERATED ALWAYS AS(n*2) STORED);
                  INSERT INTO source(id,n) VALUES(100,12),(200,20);
                  DELETE FROM source WHERE id=200;
                  CREATE TABLE pairs(a TEXT,b INTEGER,PRIMARY KEY(a,b)) WITHOUT ROWID;
                  INSERT INTO pairs VALUES('x',3),('y',4);
                  CREATE TABLE journal(message TEXT);
                  CREATE TRIGGER audit AFTER INSERT ON ratelimit BEGIN INSERT INTO journal VALUES('new'); END;
                  CREATE INDEX rates_ts ON ratelimit(ts);
                  CREATE VIEW noted AS SELECT rowid,ts,note FROM ratelimit JOIN ratelimit_note ON ratelimit.rowid=ratelimit_note.ratelimit_rowid;
                  PRAGMA user_version=42;
                """)
            before = source.read_bytes()
            report = module.compact_copy(source, target)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(report["tables"]["ratelimit"]["rows"], 2)
            with closing(sqlite3.connect(target)) as db:
                self.assertEqual(db.execute("SELECT rowid FROM ratelimit ORDER BY rowid").fetchall(), [(9,), (700,)])
                self.assertEqual(db.execute("SELECT count(*) FROM journal").fetchone(), (0,))
                self.assertEqual(db.execute("SELECT twice FROM source").fetchone(), (24,))
                db.execute("INSERT INTO source(n) VALUES(1)")
                self.assertEqual(db.execute("SELECT max(id) FROM source").fetchone(), (201,))
                self.assertEqual(db.execute("PRAGMA user_version").fetchone(), (42,))

    def test_refuses_existing_target_and_does_not_touch_it(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.sqlite", Path(directory) / "copy.sqlite"
            sqlite3.connect(source).close()
            target.write_bytes(b"keep")
            with self.assertRaises(FileExistsError):
                module.compact_copy(source, target)
            self.assertEqual(target.read_bytes(), b"keep")

    def test_failed_copy_is_not_left_as_valid_database(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.sqlite", Path(directory) / "copy.sqlite"
            with closing(sqlite3.connect(source)) as db:
                db.execute("CREATE TABLE obscure(rowid TEXT,_rowid_ TEXT,oid TEXT)")
            with self.assertRaisesRegex(ValueError, "shadowed rowid"):
                module.compact_copy(source, target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
