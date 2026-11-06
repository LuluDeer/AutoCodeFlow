"""R85：python 下载面必须**钉扎已校验 IP**（DNS rebinding 窗口）。

## 漏洞（W3 全仓普查发现的唯一中危跨端口径差）

`_download_package`（`routers/execute.py`）先做 host 闸（解析一次 → 判定），
再让 **httpx 用主机名建连**（httpx 自己再解析一次）。两次解析之间有一个窗口：

- 判定时解析到**公网** ⇒ 闸门放行；
- 建连时解析到 `169.254.169.254`（云元数据）⇒ **连到元数据端点**。

TTL=0 的攻击者域名即可稳定复现。对照：**admin** 用 `pinnedAxiosConfig`、
**node** 用 `createPinnedLookup`，**都钉扎**（校验与建连用**同一份**解析答案）。

## 本文件的模拟方式（零外网）

- `socket.getaddrinfo` 换成「解析到公网」的**闸门替身**（模拟判定时的解析）；
- 测试用的 transport **模拟 socket 层建连**：它对 `request.url.host` 做
  「第二次解析」——`MONITORED_RESOLVER` 恒返回 `169.254.169.254`
  （模拟攻击者在 TTL 窗口内切换了 DNS 答案）。
  **IP 字面量不经过解析**（真实 socket 语义）⇒ 被钉扎的请求会直接连 IP。

⇒ 旧实现：transport 看到 host 是主机名 ⇒ 第二次解析 ⇒ 记到元数据 IP（**红**）；
修后：URL 已被改写成已校验 IP ⇒ transport 看到的是 IP 字面量 ⇒ 连的是公网 IP（**绿**），
且 `Host` 头保留原主机名（虚拟主机/证书语义不变）。
"""
import httpx
import pytest

from routers import execute as execute_module


PUBLIC_IP = '93.184.216.34'
METADATA_IP = '169.254.169.254'


@pytest.fixture
def public_dns(monkeypatch):
    """闸门侧的解析：**公网**（判定时看到的是合法答案，所以闸门会放行）。"""
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', (PUBLIC_IP, 0))],
    )


def _install_socket_simulating_transport(monkeypatch, connect_log, body=b'zip-bytes'):
    """把 httpx 的 transport 换成「模拟 socket 层」的桩。

    它对每个请求做**第二次解析**（`request.url.host` → 元数据 IP），
    以此模拟 rebinding 的建连时刻。IP 字面量直接当连接目标（不解析）。
    """
    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if _is_ip(host):
            connected = host
        else:
            connected = METADATA_IP          # ← 攻击者控制的第二次解析
        connect_log.append({
            'host': host,
            'connected_ip': connected,
            'host_header': request.headers.get('host'),
            'path': request.url.path,
        })
        return httpx.Response(200, content=body)

    class PatchedClient(httpx.AsyncClient):
        def __init__(self, *a, **k):
            k['transport'] = httpx.MockTransport(handler)
            super().__init__(*a, **k)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', PatchedClient)


def _is_ip(host: str) -> bool:
    import ipaddress
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


@pytest.mark.asyncio
async def test_download_pins_validated_ip_instead_of_rebinding(
        tmp_path, monkeypatch, public_dns):
    """**核心判据**：建连目标必须是**判定时的那个 IP**，而不是第二次解析的结果。"""
    connect_log: list = []
    _install_socket_simulating_transport(monkeypatch, connect_log)
    monkeypatch.setattr(execute_module, '_assert_safe_package_url', lambda url: url)
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', False)

    dest = tmp_path / '.package.zip'
    size = await execute_module._download_package(
        'http://admin.example/packages/p.zip', dest)

    assert size == len(b'zip-bytes')
    assert connect_log, '没有发生任何请求'
    entry = connect_log[0]
    assert entry['connected_ip'] == PUBLIC_IP, (
        f"下载连到了 {entry['connected_ip']}（host={entry['host']}）—— "
        '判定时解析到公网，建连时被 rebinding 到元数据端点'
    )
    # 虚拟主机语义必须保留：Host 头仍是原主机名（不是 IP）。
    assert entry['host_header'] == 'admin.example', (
        f"Host 头应保留原主机名，实际 {entry['host_header']!r}"
    )


@pytest.mark.asyncio
async def test_redirect_hop_is_also_pinned(tmp_path, monkeypatch, public_dns):
    """**每一跳**都要重新钉扎（逐跳复检之后使用同一份解析答案）。"""
    connect_log: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        connected = host if _is_ip(host) else METADATA_IP
        connect_log.append({'host': host, 'connected_ip': connected,
                            'host_header': request.headers.get('host')})
        if request.url.path == '/packages/p.zip':
            return httpx.Response(302, headers={'Location': 'http://cdn2.example/b.zip'})
        return httpx.Response(200, content=b'zip-bytes')

    class PatchedClient(httpx.AsyncClient):
        def __init__(self, *a, **k):
            k['transport'] = httpx.MockTransport(handler)
            super().__init__(*a, **k)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', PatchedClient)
    monkeypatch.setattr(execute_module, '_assert_safe_package_url', lambda url: url)
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', False)

    dest = tmp_path / '.package.zip'
    await execute_module._download_package('http://admin.example/packages/p.zip', dest)

    assert [e['connected_ip'] for e in connect_log] == [PUBLIC_IP, PUBLIC_IP], (
        f'跳间目标没有被同时钉扎：{connect_log}'
    )


@pytest.mark.asyncio
async def test_ip_literal_url_is_not_rewritten(tmp_path, monkeypatch):
    """IP 字面量形态：本来就不经过 DNS ⇒ 不重写（保持行为与可读性）。"""
    connect_log: list = []
    _install_socket_simulating_transport(monkeypatch, connect_log)
    monkeypatch.setattr(execute_module, '_assert_safe_package_url', lambda url: url)
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', True)

    dest = tmp_path / '.package.zip'
    await execute_module._download_package(f'http://{PUBLIC_IP}/p.zip', dest)

    assert connect_log[0]['host'] == PUBLIC_IP
    assert connect_log[0]['host_header'] in (None, PUBLIC_IP)


# ---------------------------------------------------------------------------
# 钉扎单元判据：URL 改写 / Host 头 / SNI / 与闸门判定等价
# ---------------------------------------------------------------------------


def test_pinned_target_keeps_host_header_and_sni(monkeypatch):
    """https：URL 换成已校验 IP，但 `Host` 头与 `sni_hostname` 仍是原主机名。

    这条保证「证书校验不被钉扎搞坏」：httpcore 用 `sni_hostname` 作
    `server_hostname`（SNI + 证书名匹配都按它），Host 头负责虚拟主机路由。
    """
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', (PUBLIC_IP, 0))],
    )
    url, headers, extensions = execute_module._pinned_download_target(
        'https://cdn.example:8443/x.zip?q=1', False)
    assert url == f'https://{PUBLIC_IP}:8443/x.zip?q=1'
    assert headers == {'Host': 'cdn.example:8443'}
    assert extensions == {'sni_hostname': 'cdn.example'}


def test_pinned_target_omits_port_and_sni_for_plain_http(monkeypatch):
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', (PUBLIC_IP, 0))],
    )
    url, headers, extensions = execute_module._pinned_download_target(
        'http://cdn.example/x.zip', False)
    assert url == f'http://{PUBLIC_IP}/x.zip'
    assert headers == {'Host': 'cdn.example'}
    assert extensions == {}


def test_pinned_target_denies_private_ip_literal():
    """IP 字面量形态也要判定（开关关闭时私网拒）。"""
    with pytest.raises(execute_module._DownloadTargetDenied):
        execute_module._pinned_download_target('http://10.0.0.5/x.zip', False)


def test_validated_addresses_matches_the_gate():
    """**同源守卫**：`validated_addresses` 的「空/非空」必须与闸门 `_package_url_host_denied`
    逐条一致（否则钉扎路径与判定路径会悄悄分叉）。"""
    import json
    import pathlib

    import network_policy

    root = pathlib.Path(__file__).resolve().parents[3]
    protocol = json.loads(
        (root / 'packages' / 'executor-protocol' / 'protocol.json').read_text(encoding='utf-8'))
    examples = [
        ex for body in protocol['networkPolicy']['addresses'].values()
        for ex in body.get('examples', [])
    ] + [str(e).split('/')[0]
         for e in protocol['networkPolicy']['metadataAddresses']['addresses']]

    for allow in (False, True):
        for host in examples:
            allowed_by_pin = bool(network_policy.validated_addresses(
                host, allow, resolver=lambda _n: [PUBLIC_IP]))
            denied_by_gate = network_policy.host_denied_under_policy(
                host, allow, resolver=lambda _n: [PUBLIC_IP])
            assert allowed_by_pin is (not denied_by_gate), (
                f'{host} @ switch={allow}: validated_addresses={"有地址" if allowed_by_pin else "空"} '
                f'但闸门 denied={denied_by_gate} —— 钉扎路径与判定路径分叉'
            )
