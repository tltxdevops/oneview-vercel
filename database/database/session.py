from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database.config import settings


if not settings.database_url:
  raise RuntimeError("MIGRATION_DATABASE_URL is required for DB VM scripts.")

engine = create_async_engine(settings.database_url, pool_pre_ping=True)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)
