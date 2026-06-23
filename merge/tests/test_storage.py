"""Tests for storage backends (local + Cloudflare R2 via a fake S3 client)."""

from __future__ import annotations

import io

from availcal.storage import (
    MERGED_OBJECT,
    LocalStorageBackend,
    R2StorageBackend,
)

# --- local backend ---


def test_local_backend_upload_and_iter(tmp_path):
    be = LocalStorageBackend(tmp_path)
    loc = be.upload(MERGED_OBJECT, b"ICSDATA", content_type="text/calendar")
    assert (tmp_path / MERGED_OBJECT).read_bytes() == b"ICSDATA"
    assert str(tmp_path) in loc

    (tmp_path / "raw").mkdir(exist_ok=True)
    (tmp_path / "raw" / "WorkX.json").write_bytes(b"[]")
    (tmp_path / "raw" / "ignore.ics").write_bytes(b"x")
    got = dict(be.iter_raw_json())
    assert got == {"WorkX.json": b"[]"}  # only *.json


def test_local_backend_iter_missing_dir(tmp_path):
    assert list(LocalStorageBackend(tmp_path).iter_raw_json()) == []


# --- R2 backend with an injected fake S3 client ---


class FakeS3:
    """Minimal in-memory S3 stand-in: put/get/list, enough for R2StorageBackend."""

    def __init__(self):
        self.store: dict[tuple[str, str], dict] = {}

    def put_object(self, *, Bucket, Key, Body, ContentType=None):  # noqa: N803
        self.store[(Bucket, Key)] = {"Body": Body, "ContentType": ContentType}
        return {}

    def get_object(self, *, Bucket, Key):  # noqa: N803
        body = self.store[(Bucket, Key)]["Body"]
        return {"Body": io.BytesIO(body)}

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        store = self.store

        class _Paginator:
            def paginate(self, *, Bucket, Prefix=""):  # noqa: N803
                contents = [
                    {"Key": k}
                    for (b, k) in store
                    if b == Bucket and k.startswith(Prefix)
                ]
                yield {"Contents": contents}

        return _Paginator()


def test_r2_upload_returns_locator_and_stores_object():
    fake = FakeS3()
    be = R2StorageBackend(bucket="availcal", client=fake)
    loc = be.upload(MERGED_OBJECT, b"ICS", content_type="text/calendar")
    assert loc == "r2://availcal/merged/availability.ics"
    stored = fake.store[("availcal", MERGED_OBJECT)]
    assert stored["Body"] == b"ICS"
    assert stored["ContentType"] == "text/calendar"


def test_r2_iter_raw_json_only_json_under_raw_prefix():
    fake = FakeS3()
    be = R2StorageBackend(bucket="availcal", client=fake)
    fake.put_object(Bucket="availcal", Key="raw/WorkX.json", Body=b'[{"x":1}]')
    fake.put_object(Bucket="availcal", Key="raw/Mac.json", Body=b"[]")
    fake.put_object(Bucket="availcal", Key="raw/Work.ics", Body=b"BEGIN")
    fake.put_object(Bucket="availcal", Key="merged/availability.ics", Body=b"BEGIN")
    got = dict(be.iter_raw_json())
    assert set(got.keys()) == {"raw/WorkX.json", "raw/Mac.json"}
    assert got["raw/WorkX.json"] == b'[{"x":1}]'


def test_r2_requires_endpoint_or_account_id():
    import pytest

    with pytest.raises(ValueError, match="ACCOUNT_ID or AVAILCAL_R2_ENDPOINT"):
        R2StorageBackend(bucket="availcal")  # no client, no account/endpoint


class FakeAzureContainer:
    """Records upload_blob kwargs to verify ContentSettings usage."""

    def __init__(self):
        self.calls = []

    def upload_blob(self, **kwargs):
        self.calls.append(kwargs)


def test_azure_backend_uses_content_settings_not_content_type():
    from availcal.storage import AzureBlobBackend

    fake = FakeAzureContainer()
    be = AzureBlobBackend(container="availcal", client=fake)
    be.upload(MERGED_OBJECT, b"ICS", content_type="text/calendar")
    [call] = fake.calls
    # The real SDK has no content_type kwarg; we must pass content_settings.
    assert "content_type" not in call
    assert call["content_settings"].content_type == "text/calendar"
    assert call["overwrite"] is True
