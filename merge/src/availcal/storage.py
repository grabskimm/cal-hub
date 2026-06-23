"""Storage backends: where outputs are written and raw device JSON is read.

One small abstraction, three implementations selected by config:

  * ``LocalStorageBackend``  — a directory on disk (dev / CI / container demo).
  * ``R2StorageBackend``     — Cloudflare R2 via its S3-compatible API (boto3).
  * ``AzureBlobBackend``     — Azure Blob (connection string or Managed Identity).

Each backend can ``upload`` a named object and ``iter_raw_json`` the
``raw/*.json`` device-agent uploads. The layout is identical across backends:

    raw/<source>.json          # device-agent uploads (input)
    merged/availability.ics     # the merged free/busy feed (output)
    raw/<label>.ics             # optional per-source overlays (output)
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from pathlib import Path
from typing import Protocol, runtime_checkable

log = logging.getLogger("availcal.storage")

MERGED_OBJECT = "merged/availability.ics"
# Fully-anonymized public feed (no source labels); served without a token.
PUBLIC_OBJECT = "public/availability.ics"
RAW_PREFIX = "raw/"


@runtime_checkable
class StorageBackend(Protocol):
    """Minimal contract the orchestrator depends on."""

    def upload(self, name: str, data: bytes, content_type: str = "text/calendar") -> str:
        """Write ``data`` at object key ``name`` (overwriting). Return its locator."""
        ...

    def iter_raw_json(self) -> Iterable[tuple[str, bytes]]:
        """Yield ``(name, bytes)`` for every ``raw/*.json`` device upload."""
        ...


class LocalStorageBackend:
    """Write to / read from a local directory tree (dev, CI, container demo)."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def upload(self, name: str, data: bytes, content_type: str = "text/calendar") -> str:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return str(path)

    def iter_raw_json(self) -> Iterable[tuple[str, bytes]]:
        raw = self.root / RAW_PREFIX
        if not raw.is_dir():
            return
        for jf in sorted(raw.glob("*.json")):
            yield jf.name, jf.read_bytes()


class R2StorageBackend:
    """Cloudflare R2 via the S3-compatible API (boto3).

    R2 speaks S3, so we use a standard boto3 S3 client pointed at the account's
    R2 endpoint with ``region_name='auto'``. Credentials are an R2 API token's
    access-key-id / secret-access-key (least-privilege: object read+write on the
    one bucket). A ``client`` may be injected for testing.
    """

    def __init__(
        self,
        *,
        bucket: str,
        account_id: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        endpoint_url: str | None = None,
        client=None,
    ) -> None:
        self.bucket = bucket
        if client is not None:
            self._client = client
        else:
            import boto3
            from botocore.config import Config as BotoConfig

            endpoint = endpoint_url or (
                f"https://{account_id}.r2.cloudflarestorage.com"
                if account_id
                else None
            )
            if not endpoint:
                raise ValueError(
                    "R2 backend needs AVAILCAL_R2_ACCOUNT_ID or AVAILCAL_R2_ENDPOINT"
                )
            self._client = boto3.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key,
                region_name="auto",
                # R2 requires the modern checksum behaviour off for some clients;
                # default signature v4 is correct.
                config=BotoConfig(signature_version="s3v4"),
            )

    def upload(self, name: str, data: bytes, content_type: str = "text/calendar") -> str:
        self._client.put_object(
            Bucket=self.bucket, Key=name, Body=data, ContentType=content_type
        )
        return f"r2://{self.bucket}/{name}"

    def iter_raw_json(self) -> Iterable[tuple[str, bytes]]:
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=RAW_PREFIX):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key.endswith(".json"):
                    body = self._client.get_object(Bucket=self.bucket, Key=key)["Body"]
                    yield key, body.read()


class AzureBlobBackend:
    """Azure Blob backend (connection string or system-assigned Managed Identity)."""

    def __init__(
        self,
        *,
        container: str,
        connection_string: str | None = None,
        storage_account: str | None = None,
        client=None,
    ) -> None:
        if client is not None:
            self._container = client
        elif connection_string:
            from azure.storage.blob import ContainerClient

            self._container = ContainerClient.from_connection_string(
                connection_string, container
            )
        elif storage_account:
            from azure.identity import DefaultAzureCredential
            from azure.storage.blob import ContainerClient

            self._container = ContainerClient(
                account_url=f"https://{storage_account}.blob.core.windows.net",
                container_name=container,
                credential=DefaultAzureCredential(),
            )
        else:
            raise ValueError(
                "Azure backend needs a connection string or storage account name"
            )

    def upload(self, name: str, data: bytes, content_type: str = "text/calendar") -> str:
        # azure-storage-blob's upload_blob takes content type via ContentSettings,
        # NOT a `content_type` kwarg (which would raise TypeError).
        from azure.storage.blob import ContentSettings

        self._container.upload_blob(
            name=name,
            data=data,
            overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )
        return name

    def iter_raw_json(self) -> Iterable[tuple[str, bytes]]:
        for blob in self._container.list_blobs(name_starts_with=RAW_PREFIX):
            if blob.name.endswith(".json"):
                data = self._container.download_blob(blob.name).readall()
                yield blob.name, data
