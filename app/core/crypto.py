"""AES-256-GCM credential encryption (stdlib + cryptography lib)."""
from __future__ import annotations

import base64
import hashlib
import os

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _HAS_CRYPTO = True
except Exception:  # pragma: no cover
    _HAS_CRYPTO = False


def _key32(master: str) -> bytes:
    return hashlib.sha256(master.encode()).digest()


def encrypt(master: str, plaintext: str) -> str:
    raw = plaintext.encode()
    if _HAS_CRYPTO:
        nonce = os.urandom(12)
        ct = AESGCM(_key32(master)).encrypt(nonce, raw, None)
        return "gcm:" + base64.b64encode(nonce + ct).decode()
    # fallback obfuscation (dev only)
    x = _key32(master)
    enc = bytes(b ^ x[i % 32] for i, b in enumerate(raw))
    return "xor:" + base64.b64encode(enc).decode()


def decrypt(master: str, blob: str) -> str:
    if blob.startswith("gcm:"):
        if not _HAS_CRYPTO:
            raise RuntimeError("cryptography package required to decrypt")
        data = base64.b64decode(blob[4:])
        nonce, ct = data[:12], data[12:]
        return AESGCM(_key32(master)).decrypt(nonce, ct, None).decode()
    if blob.startswith("xor:"):
        data = base64.b64decode(blob[4:])
        x = _key32(master)
        return bytes(b ^ x[i % 32] for i, b in enumerate(data)).decode()
    return blob  # plain (legacy)
