import pytest
from unittest.mock import AsyncMock, patch

from config import settings
from main import register_executor


@pytest.mark.asyncio
async def test_register_executor_posts_capacity_metadata(monkeypatch):
    """Python executor registration should report scheduler capacity to admin-api."""
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', None)
    monkeypatch.setattr(settings, 'admin_api_url_external', None)
    monkeypatch.setattr(settings, 'app_name', 'py-executor')
    monkeypatch.setattr(settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(settings, 'executor_address_public', '')
    monkeypatch.setattr(settings, 'max_concurrent_tasks', 7)

    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.post = AsyncMock()

    with patch('main.get_current_token', new=AsyncMock(return_value='test-token')), \
         patch('main.httpx.AsyncClient', return_value=mock_client):
        await register_executor()

    mock_client.post.assert_awaited_once()
    _, kwargs = mock_client.post.call_args
    assert kwargs['headers'] == {'Authorization': 'Bearer test-token'}
    assert kwargs['json'] == {
        'appName': 'py-executor',
        'address': 'localhost:8001',
        'type': 'python',
        'version': '1.0.0',
        'capabilities': ['python', 'shell'],
        'maxConcurrentTasks': 7,
    }
