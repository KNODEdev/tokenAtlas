"""Create a compact, verified SQLite copy without renumbering implicit rowids.

Use on an offline migration copy, never to replace a running application's DB.
The source is opened read-only. The destination must not exist.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
import time


def identifier(name):
    return '"' + name.replace('"', '""') + '"'


def digest_rows(rows):
    digest = hashlib.sha256()
    count = 0
    for row in rows:
        for value in row:
            if value is None:
                tag, body = b"n", b""
            elif isinstance(value, int):
                tag, body = b"i", str(value).encode("ascii")
            elif isinstance(value, float):
                tag, body = b"f", struct.pack(">d", value)
            elif isinstance(value, bytes):
                tag, body = b"b", value
            else:
                tag, body = b"s", value.encode("utf-8")
            digest.update(tag + struct.pack(">Q", len(body)) + body)
        digest.update(b"r")
        count += 1
    return {"rows": count, "sha256": digest.hexdigest()}


def table_projection(connection, name):
    columns = connection.execute(f"PRAGMA table_xinfo({identifier(name)})").fetchall()
    writable = [row[1] for row in columns if row[6] == 0]
    all_columns = [row[1] for row in columns]
    table = next(row for row in connection.execute("PRAGMA table_list") if row[1] == name and row[0] == "main")
    if table[2] not in ("table",):
        raise ValueError(f"Unsupported virtual/shadow table: {name}")
    without_rowid = bool(table[4])
    rowid = None
    if not without_rowid:
        names = {column.lower() for column in all_columns}
        rowid = next((alias for alias in ("rowid", "_rowid_", "oid") if alias not in names), None)
        if rowid is None:
            raise ValueError(f"Cannot preserve shadowed rowid of {name}")
    insert_columns = ([rowid] if rowid else []) + writable
    check_columns = ([rowid] if rowid else []) + all_columns
    order_columns = [rowid] if rowid else [row[1] for row in sorted(columns, key=lambda row: row[5]) if row[5]]
    return insert_columns, check_columns, order_columns


def compact_copy(source, destination, progress=None):
    source, destination = Path(source).resolve(strict=True), Path(destination).resolve()
    if source == destination:
        raise ValueError("Source and destination must differ")
    # Exclusive creation prevents silently opening or replacing any existing DB.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    started = time.monotonic()
    report = {"source_bytes": source.stat().st_size, "tables": {}}
    reader = writer = None
    try:
        reader = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
        reader.execute("PRAGMA query_only=ON")
        reader.execute("BEGIN")
        schema = reader.execute("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").fetchall()
        writer = sqlite3.connect(destination)
        writer.execute("PRAGMA journal_mode=DELETE")
        writer.execute("PRAGMA foreign_keys=OFF")
        writer.execute("PRAGMA synchronous=FULL")
        writer.execute("BEGIN")
        for kind, name, sql in schema:
            if kind != "table" or name.startswith("sqlite_"):
                continue
            if sql.upper().startswith("CREATE VIRTUAL TABLE"):
                raise ValueError(f"Unsupported virtual table: {name}")
            writer.execute(sql)
            insert_columns, check_columns, order_columns = table_projection(reader, name)
            selected = ",".join(map(identifier, insert_columns))
            order = ",".join(map(identifier, order_columns))
            query = f"SELECT {selected} FROM {identifier(name)} ORDER BY {order}"
            insert = f"INSERT INTO {identifier(name)} ({selected}) VALUES ({','.join('?' for _ in insert_columns)})"
            cursor = reader.execute(query)
            while batch := cursor.fetchmany(1000):
                writer.executemany(insert, batch)
            check = f"SELECT {','.join(map(identifier, check_columns))} FROM {identifier(name)} ORDER BY {order}"
            original = digest_rows(reader.execute(check))
            copied = digest_rows(writer.execute(check))
            if original != copied:
                raise ValueError(f"Copy verification failed for {name}")
            report["tables"][name] = copied
            if progress:
                progress({"table": name, **copied})
        # Autoincrement high-water marks may exceed the largest surviving ID.
        if reader.execute("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").fetchone():
            writer.execute("DELETE FROM sqlite_sequence")
            writer.executemany("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)", reader.execute("SELECT name,seq FROM sqlite_sequence"))
        # Install triggers after copying so they cannot re-derive or modify facts.
        for kind in ("index", "view", "trigger"):
            for entry_kind, name, sql in schema:
                if entry_kind == kind and not name.startswith("sqlite_"):
                    writer.execute(sql)
        for pragma in ("user_version", "application_id"):
            writer.execute(f"PRAGMA {pragma}={int(reader.execute(f'PRAGMA {pragma}').fetchone()[0])}")
        actual_schema = writer.execute("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
        expected_schema = reader.execute("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
        if actual_schema != expected_schema:
            raise ValueError("Schema changed during copy")
        if writer.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Integrity check failed")
        # Existing violations are preserved and reported, never silently repaired.
        original_fk = sorted(reader.execute("PRAGMA foreign_key_check").fetchall())
        copied_fk = sorted(writer.execute("PRAGMA foreign_key_check").fetchall())
        if original_fk != copied_fk:
            raise ValueError("Foreign-key relationships changed")
        report["existing_foreign_key_violations"] = len(original_fk)
        writer.commit()
        report["destination_bytes"] = destination.stat().st_size
        report["seconds"] = round(time.monotonic() - started, 3)
        return report
    except BaseException:
        if writer:
            writer.close()
            writer = None
        destination.unlink(missing_ok=True)
        raise
    finally:
        if writer:
            writer.close()
        if reader:
            reader.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    report_path = Path(args.report).resolve()
    if report_path in (Path(args.source).resolve(), Path(args.destination).resolve()):
        parser.error("Report must not overwrite either database")
    with report_path.open("x", encoding="utf-8") as report_file:
        report = compact_copy(args.source, args.destination, lambda event: print(json.dumps(event), flush=True))
        json.dump(report, report_file, indent=2)
    print(json.dumps({key: value for key, value in report.items() if key != "tables"}))
