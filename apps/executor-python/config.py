from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = 'executor-python-1'
    port: int = 8001
    executor_address: str = 'executor-python:8001'
    executor_address_public: str = ''
    admin_api_url: str = 'http://admin-api:3105'
    admin_api_url_internal: str = ''
    admin_api_url_external: str = ''
    executor_shared_token: str = ''
    work_dir: str = '/tmp/autocodeflow/tasks'
    max_concurrent_tasks: int = 10
    task_timeout_seconds: int = 300  # Default task timeout (5 minutes)
    heartbeat_interval_seconds: int = 30  # Heartbeat interval
    pypi_registry_url: str = ''  # Private PyPI registry URL for task dependencies

    class Config:
        env_file = '.env'


settings = Settings()
