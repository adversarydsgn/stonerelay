#!/usr/bin/env python3
import argparse
import asyncio
import fcntl
import json
import os
import secrets
from pathlib import Path


class LockfileNotInitialized(RuntimeError):
    pass


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _claim_next_id_sync(db_path: Path) -> int:
    lock_path = db_path / ".next-id.lock"
    data_path = db_path / ".next-id"
    with lock_path.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            try:
                raw = data_path.read_text(encoding="utf-8").strip()
            except FileNotFoundError as exc:
                raise LockfileNotInitialized(
                    f"{db_path.name}/.next-id is missing or empty; bootstrap migration must run before first vault-canonical write"
                ) from exc
            if not raw:
                raise LockfileNotInitialized(
                    f"{db_path.name}/.next-id is missing or empty; bootstrap migration must run before first vault-canonical write"
                )
            current = int(raw)
            temp_path = db_path / f".next-id.tmp.{os.getpid()}.{secrets.token_hex(8)}"
            with temp_path.open("w", encoding="utf-8") as temp_file:
                temp_file.write(f"{current + 1}\n")
                temp_file.flush()
                os.fsync(temp_file.fileno())
            os.replace(temp_path, data_path)
            _fsync_directory(db_path)
            return current
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


async def claim_next_id(db_path: Path) -> int:
    return await asyncio.to_thread(_claim_next_id_sync, db_path)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("db_path")
    parser.add_argument("--sequential", type=int, default=10)
    parser.add_argument("--concurrent", type=int, default=100)
    args = parser.parse_args()

    db_path = Path(args.db_path)
    original = (db_path / ".next-id").read_text(encoding="utf-8")
    try:
        sequential_ids = [await claim_next_id(db_path) for _ in range(args.sequential)]
        concurrent_ids = await asyncio.gather(*(claim_next_id(db_path) for _ in range(args.concurrent)))
        print(json.dumps({
            "sequential": sequential_ids,
            "concurrent": concurrent_ids,
            "afterClaims": int((db_path / ".next-id").read_text(encoding="utf-8").strip()),
        }))
    finally:
        (db_path / ".next-id").write_text(original, encoding="utf-8")
        _fsync_directory(db_path)


if __name__ == "__main__":
    asyncio.run(main())
