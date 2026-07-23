import pytest
from sqlmodel import Session, SQLModel, create_engine

from finanse import models  # noqa: F401  (register tables)


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s
