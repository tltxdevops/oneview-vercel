import os
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def _getenv(name: str, default: str = "") -> str:
  return os.getenv(name, default).strip()


@dataclass(frozen=True)
class DatabaseSettings:
  migration_database_url: str
  zabbix_token_encryption_key: str
  zabbix_pilot_name: str
  zabbix_pilot_api_url: str
  zabbix_pilot_token: str
  zabbix_pilot_group_filter: str
  zabbix_pilot_environment: str
  zabbix_pilot_rate_limit_per_minute: int

  @property
  def database_url(self) -> str:
    return self.migration_database_url


def get_database_settings() -> DatabaseSettings:
  return DatabaseSettings(
    migration_database_url=_getenv("MIGRATION_DATABASE_URL"),
    zabbix_token_encryption_key=_getenv("ZABBIX_TOKEN_ENCRYPTION_KEY"),
    zabbix_pilot_name=_getenv("ZABBIX_PILOT_NAME"),
    zabbix_pilot_api_url=_getenv("ZABBIX_PILOT_API_URL"),
    zabbix_pilot_token=_getenv("ZABBIX_PILOT_TOKEN"),
    zabbix_pilot_group_filter=_getenv("ZABBIX_PILOT_GROUP_FILTER"),
    zabbix_pilot_environment=_getenv("ZABBIX_PILOT_ENVIRONMENT", "external"),
    zabbix_pilot_rate_limit_per_minute=int(_getenv("ZABBIX_PILOT_RATE_LIMIT_PER_MINUTE", "60")),
  )


settings = get_database_settings()
