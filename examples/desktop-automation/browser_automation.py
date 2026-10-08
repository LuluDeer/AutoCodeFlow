"""
浏览器自动化示例任务
功能：打开网页，执行搜索，截图保存为执行产物（artifacts）
依赖：pip install selenium
"""
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import json
import os
import tempfile
import time
from pathlib import Path

from autoflow_sdk import TaskContext


def get_typed_param(ctx, key, default=None):
    """
    JSON 容错解析任务参数。

    执行器把所有触发参数字符串化注入（AUTOFLOW_* 环境变量），python SDK
    from_env 不做类型还原——列表/数字/布尔参数拿到的都是字符串。尝试
    json.loads 还原，失败则原样返回字符串（对齐 Node 示例 getParam 的兜底）。

    另有一处键名陷阱：执行器注入时把键名**大写**（`AUTOFLOW_{k.upper()}`，
    见 apps/executor-python/routers/execute.py），而 SDK 读回时把键名**小写**
    （context.py: params[...lower()]）。于是任务配置里写成 camelCase 的键
    （`sourceDir`）在 ctx.params 里只以小写形态（`sourcedir`）存在，按原样
    查找恒为 None、静默落回默认值。这里补一次小写回退查找。
    """
    raw = ctx.get_param(key)
    if raw is None and key != key.lower():
        raw = ctx.get_param(key.lower())
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw


def is_truthy_param(value) -> bool:
    """布尔参数显式判定：字符串 "true"/"1" 为真，"false"/"0" 为假。
    避免 if value: 对非空字符串（如 "false"）恒真的真值反转。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


def resolve_artifacts_dir(ctx) -> Path:
    """产物目录：优先用执行器注入的 AUTOFLOW_ARTIFACTS_DIR（FEAT-05）。

    执行器把该变量指向 <work_dir>/artifacts/ 并已预建目录；任务结束时执行器
    扫描该目录、上传文件、把清单随终态回调上报，用户即可在执行详情页查看。
    本地裸跑（无执行器）时回退到系统临时目录，保持可调试。
    """
    injected = ctx.get_env("AUTOFLOW_ARTIFACTS_DIR") or ctx.get_param("artifacts_dir")
    if injected:
        return Path(injected)
    return Path(tempfile.gettempdir()) / f"browser_automation_{ctx.execution_id}"


def main():
    ctx = TaskContext.from_env()

    # 获取任务参数（JSON 容错解析 + 布尔显式比较，见 helper 注释）
    url = get_typed_param(ctx, "url", "https://www.baidu.com")
    search_keyword = get_typed_param(ctx, "keyword", "AutoCodeFlow")
    headless = is_truthy_param(get_typed_param(ctx, "headless", False))

    ctx.log.info("开始浏览器自动化任务")
    ctx.log.info(f"目标URL: {url}")
    ctx.log.info(f"搜索关键词: {search_keyword}")

    # 产物目录（FEAT-05）：写进这里才能在执行详情页看到截图/文本
    output_dir = resolve_artifacts_dir(ctx)
    output_dir.mkdir(parents=True, exist_ok=True)
    ctx.log.info(f"产物目录: {output_dir}")

    driver = None
    try:
        # 启动浏览器
        options = webdriver.ChromeOptions()
        if headless:
            options.add_argument("--headless")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--window-size=1920,1080")

        driver = webdriver.Chrome(options=options)
        driver.set_window_size(1920, 1080)

        ctx.log.info("浏览器启动成功")

        # 打开网页
        driver.get(url)
        ctx.log.info(f"已打开: {url}")
        time.sleep(2)

        # 截图 - 初始页面
        initial_screenshot = output_dir / "01_initial_page.png"
        driver.save_screenshot(str(initial_screenshot))
        ctx.log.info(f"已保存初始截图: {initial_screenshot.name}")

        # 执行搜索
        search_box = WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.ID, "kw"))
        )
        search_box.clear()
        search_box.send_keys(search_keyword)

        search_button = driver.find_element(By.ID, "su")
        search_button.click()

        ctx.log.info(f"已执行搜索: {search_keyword}")
        time.sleep(3)

        # 截图 - 搜索结果
        results_screenshot = output_dir / "02_search_results.png"
        driver.save_screenshot(str(results_screenshot))
        ctx.log.info(f"已保存搜索结果截图: {results_screenshot.name}")

        # 获取搜索结果
        results = driver.find_elements(By.CSS_SELECTOR, ".result h3 a")
        ctx.log.info(f"找到 {len(results)} 个搜索结果")

        # 保存搜索结果到文件
        results_file = output_dir / "search_results.txt"
        with open(results_file, "w", encoding="utf-8") as f:
            for i, result in enumerate(results[:10], 1):
                try:
                    text = result.text
                    href = result.get_attribute("href")
                    f.write(f"{i}. {text}\n")
                    f.write(f"   链接: {href}\n\n")
                except Exception as e:
                    ctx.log.warning(f"获取第 {i} 个结果失败: {e}")

        ctx.log.info(f"搜索结果已保存到: {results_file.name}")

        # 点击第一个结果（仅有结果时；截图路径无条件预置，避免引用未绑定变量）
        target_screenshot = output_dir / "03_target_page.png"
        if results:
            results[0].click()
            ctx.log.info("已点击第一个搜索结果")
            time.sleep(3)

            driver.save_screenshot(str(target_screenshot))
            ctx.log.info(f"已保存目标页面截图: {target_screenshot.name}")

        # 返回结果。产物文件名以裸名列出（执行器上报的清单用的就是裸名）。
        result = {
            "success": True,
            "message": "浏览器自动化任务完成",
            "artifacts_dir": str(output_dir),
            "screenshots": [
                initial_screenshot.name,
                results_screenshot.name,
                *([target_screenshot.name] if results else []),
            ],
            "results_file": results_file.name,
            "search_results_count": len(results),
        }

        print(f"RESULT: {result}")
        return result

    finally:
        # 无论成功/失败/异常都要关掉浏览器，避免执行器节点残留进程
        if driver is not None:
            try:
                driver.quit()
                ctx.log.info("浏览器已关闭")
            except Exception as e:  # noqa: BLE001 —— 清理失败不掩盖真实错误
                ctx.log.warning(f"关闭浏览器失败: {e}")


if __name__ == "__main__":
    # 失败语义：抛异常 → 执行器判 FAILED（退出码非 0）。
    # 刻意**不**在 except 里 `return {"success": False}`——执行器只认进程退出码，
    # 返回 dict 不影响判定，那样会让失败任务在平台上显示为成功（假绿）。
    main()
