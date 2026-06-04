from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = 'executor-python-1'
    port: int = 8001
    executor_address: str = 'executor-python:8001'
    admin_api_url: str = 'http://admin-api:3001'
    work_dir: str = '/tmp/autoflow/tasks'
    max_concurrent_tasks: int = 10

    class Config:
        env_file = '.env'


settings = Settings()
