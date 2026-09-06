"""
浏览器自动化示例任务
功能：打开网页，执行搜索，截图保存
依赖：pip install selenium playwright
"""
import asyncio
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time
import os
import json
from pathlib import Path
from autoflow_sdk import TaskContext


def get_typed_param(ctx, key, default=None):
    """
    JSON 容错解析任务参数。

    执行器把所有触发参数字符串化注入（AUTOFLOW_* 环境变量），python SDK
    from_env 不做类型还原——列表/数字/布尔参数拿到的都是字符串。尝试
    json.loads 还原，失败则原样返回字符串（对齐 Node 示例 getParam 的兜底）。
    """
    raw = ctx.get_param(key)
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


def main():
    ctx = TaskContext.from_env()
    
    # 获取任务参数（JSON 容错解析 + 布尔显式比较，见 helper 注释）
    url = get_typed_param(ctx, "url", "https://www.baidu.com")
    search_keyword = get_typed_param(ctx, "keyword", "AutoCodeFlow")
    headless = is_truthy_param(get_typed_param(ctx, "headless", False))
    
    ctx.log.info(f"开始浏览器自动化任务")
    ctx.log.info(f"目标URL: {url}")
    ctx.log.info(f"搜索关键词: {search_keyword}")
    
    # 创建输出目录
    output_dir = Path(f"/tmp/browser_automation_{ctx.execution_id}")
    output_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        # 启动浏览器
        options = webdriver.ChromeOptions()
        if headless:
            options.add_argument('--headless')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--window-size=1920,1080')
        
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
        ctx.log.info(f"已保存初始截图: {initial_screenshot}")
        
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
        ctx.log.info(f"已保存搜索结果截图: {results_screenshot}")
        
        # 获取搜索结果
        results = driver.find_elements(By.CSS_SELECTOR, ".result h3 a")
        ctx.log.info(f"找到 {len(results)} 个搜索结果")
        
        # 保存搜索结果到文件
        results_file = output_dir / "search_results.txt"
        with open(results_file, 'w', encoding='utf-8') as f:
            for i, result in enumerate(results[:10], 1):
                try:
                    text = result.text
                    href = result.get_attribute('href')
                    f.write(f"{i}. {text}\n")
                    f.write(f"   链接: {href}\n\n")
                except Exception as e:
                    ctx.log.warning(f"获取第 {i} 个结果失败: {e}")
        
        ctx.log.info(f"搜索结果已保存到: {results_file}")
        
        # 点击第一个结果
        if results:
            first_result = results[0]
            first_result.click()
            ctx.log.info("已点击第一个搜索结果")
            time.sleep(3)
            
            # 截图 - 目标页面
            target_screenshot = output_dir / "03_target_page.png"
            driver.save_screenshot(str(target_screenshot))
            ctx.log.info(f"已保存目标页面截图: {target_screenshot}")
        
        # 关闭浏览器
        driver.quit()
        ctx.log.info("浏览器已关闭")
        
        # 返回结果
        result = {
            "success": True,
            "message": "浏览器自动化任务完成",
            "output_dir": str(output_dir),
            "screenshots": [
                str(initial_screenshot),
                str(results_screenshot),
                str(target_screenshot)
            ],
            "results_file": str(results_file),
            "search_results_count": len(results)
        }
        
        print(f"RESULT: {result}")
        return result
        
    except Exception as e:
        ctx.log.error(f"任务执行失败: {str(e)}")
        error_result = {
            "success": False,
            "error": str(e),
            "output_dir": str(output_dir)
        }
        print(f"RESULT: {error_result}")
        return error_result


if __name__ == "__main__":
    main()