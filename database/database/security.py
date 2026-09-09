from cryptography.fernet import Fernet, InvalidToken

from database.config import settings


def generate_token_encryption_key() -> str:
  return Fernet.generate_key().decode("ascii")


def _fernet() -> Fernet:
  if not settings.zabbix_token_encryption_key:
    raise RuntimeError("ZABBIX_TOKEN_ENCRYPTION_KEY must be configured on the DB VM.")
  return Fernet(settings.zabbix_token_encryption_key.encode("ascii"))


def encrypt_secret(value: str) -> str:
  return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(value: str) -> str:
  try:
    return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
  except InvalidToken as exc:
    raise RuntimeError("Stored Zabbix token could not be decrypted") from exc
