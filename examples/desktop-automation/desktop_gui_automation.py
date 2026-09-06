"""
桌面GUI自动化示例任务
功能：鼠标键盘操作、屏幕截图、图像识别
依赖：pip install pyautogui opencv-python pillow
"""
import pyautogui
import time
import os
import json
from pathlib import Path
from autoflow_sdk import TaskContext
import cv2
import numpy as np


def get_typed_param(ctx, key, default=None):
    """
    JSON 容错解析任务参数。

    执行器把所有触发参数字符串化注入（AUTOFLOW_* 环境变量），python SDK
    from_env 不做类型还原——actions 这类列表参数拿到的其实是字符串，
    直接按列表迭代只会逐字符空转。尝试 json.loads 还原，失败则原样返回
    字符串（对齐 Node 示例 getParam 的兜底语义）。
    """
    raw = ctx.get_param(key)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw


def main():
    ctx = TaskContext.from_env()
    
    # 获取任务参数（actions 列表经 JSON 容错解析还原，见 helper 注释）
    actions = get_typed_param(ctx, "actions", [])
    if not isinstance(actions, list):
        ctx.log.warning("actions 参数应为 JSON 数组，已按空列表处理")
        actions = []
    screenshot_interval = get_typed_param(ctx, "screenshotInterval", 2)
    output_dir = get_typed_param(ctx, "outputDir", f"/tmp/desktop_automation_{ctx.execution_id}")
    
    ctx.log.info("开始桌面GUI自动化任务")
    
    # 创建输出目录
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # 设置pyautogui安全措施
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 1
    
    try:
        screenshots = []
        action_results = []
        
        # 初始截图
        initial_screen = output_path / "00_initial_screen.png"
        pyautogui.screenshot(str(initial_screen))
        screenshots.append(str(initial_screen))
        ctx.log.info(f"已保存初始屏幕截图: {initial_screen}")
        
        # 获取屏幕尺寸
        screen_width, screen_height = pyautogui.size()
        ctx.log.info(f"屏幕尺寸: {screen_width}x{screen_height}")
        
        # 执行动作序列
        for i, action in enumerate(actions):
            action_type = action.get("type")
            ctx.log.info(f"执行动作 {i+1}/{len(actions)}: {action_type}")
            
            result = {"action": action_type, "success": True}
            
            if action_type == "move":
                x = action.get("x", screen_width // 2)
                y = action.get("y", screen_height // 2)
                duration = action.get("duration", 0.5)
                pyautogui.moveTo(x, y, duration=duration)
                result["position"] = {"x": x, "y": y}
                
            elif action_type == "click":
                x = action.get("x", screen_width // 2)
                y = action.get("y", screen_height // 2)
                clicks = action.get("clicks", 1)
                button = action.get("button", "left")
                pyautogui.click(x, y, clicks=clicks, button=button)
                result["position"] = {"x": x, "y": y}
                result["clicks"] = clicks
                
            elif action_type == "double_click":
                x = action.get("x", screen_width // 2)
                y = action.get("y", screen_height // 2)
                pyautogui.doubleClick(x, y)
                result["position"] = {"x": x, "y": y}
                
            elif action_type == "right_click":
                x = action.get("x", screen_width // 2)
                y = action.get("y", screen_height // 2)
                pyautogui.rightClick(x, y)
                result["position"] = {"x": x, "y": y}
                
            elif action_type == "drag":
                start_x = action.get("startX", screen_width // 2)
                start_y = action.get("startY", screen_height // 2)
                end_x = action.get("endX", screen_width // 2 + 100)
                end_y = action.get("endY", screen_height // 2)
                duration = action.get("duration", 1)
                pyautogui.dragTo(end_x, end_y, duration=duration, button='left')
                result["from"] = {"x": start_x, "y": start_y}
                result["to"] = {"x": end_x, "y": end_y}
                
            elif action_type == "type":
                text = action.get("text", "")
                interval = action.get("interval", 0.1)
                pyautogui.write(text, interval=interval)
                result["text_length"] = len(text)
                
            elif action_type == "hotkey":
                keys = action.get("keys", [])
                pyautogui.hotkey(*keys)
                result["keys"] = keys
                
            elif action_type == "press":
                key = action.get("key", "enter")
                presses = action.get("presses", 1)
                for _ in range(presses):
                    pyautogui.press(key)
                result["key"] = key
                result["presses"] = presses
                
            elif action_type == "scroll":
                clicks = action.get("clicks", -10)
                x = action.get("x", screen_width // 2)
                y = action.get("y", screen_height // 2)
                pyautogui.scroll(clicks, x=x, y=y)
                result["scroll_clicks"] = clicks
                
            elif action_type == "screenshot":
                screenshot_path = output_path / f"screenshot_{i+1}.png"
                pyautogui.screenshot(str(screenshot_path))
                screenshots.append(str(screenshot_path))
                result["path"] = str(screenshot_path)
                
            elif action_type == "find_and_click":
                image_path = action.get("imagePath")
                confidence = action.get("confidence", 0.8)
                
                if image_path and os.path.exists(image_path):
                    try:
                        location = pyautogui.locateOnScreen(image_path, confidence=confidence)
                        if location:
                            center = pyautogui.center(location)
                            pyautogui.click(center.x, center.y)
                            result["found"] = True
                            result["position"] = {"x": center.x, "y": center.y}
                        else:
                            result["found"] = False
                            result["error"] = "图像未找到"
                    except Exception as e:
                        result["found"] = False
                        result["error"] = str(e)
                else:
                    result["found"] = False
                    result["error"] = "图像文件不存在"
            
            # 动作后截图
            if action_type != "screenshot":
                time.sleep(0.5)
                action_screenshot = output_path / f"action_{i+1}.png"
                pyautogui.screenshot(str(action_screenshot))
                screenshots.append(str(action_screenshot))
            
            action_results.append(result)
            time.sleep(screenshot_interval)
        
        # 最终截图
        final_screen = output_path / "99_final_screen.png"
        pyautogui.screenshot(str(final_screen))
        screenshots.append(str(final_screen))
        ctx.log.info(f"已保存最终屏幕截图: {final_screen}")
        
        # 生成动作报告
        report_file = output_path / "automation_report.txt"
        with open(report_file, 'w', encoding='utf-8') as f:
            f.write("桌面GUI自动化任务报告\n")
            f.write("=" * 50 + "\n\n")
            f.write(f"执行ID: {ctx.execution_id}\n")
            f.write(f"屏幕尺寸: {screen_width}x{screen_height}\n")
            f.write(f"动作总数: {len(actions)}\n")
            f.write(f"截图数量: {len(screenshots)}\n\n")
            
            f.write("动作执行详情:\n")
            f.write("-" * 50 + "\n")
            for i, result in enumerate(action_results, 1):
                status = "✓" if result.get("success") else "✗"
                f.write(f"{i}. [{status}] {result['action']}\n")
                if not result.get("success"):
                    f.write(f"   错误: {result.get('error', 'Unknown')}\n")
            
            f.write("\n截图文件:\n")
            f.write("-" * 50 + "\n")
            for screenshot in screenshots:
                f.write(f"- {screenshot}\n")
        
        ctx.log.info(f"动作报告已保存: {report_file}")
        
        # 返回结果
        result = {
            "success": True,
            "message": "桌面GUI自动化任务完成",
            "output_dir": str(output_path),
            "screenshots": screenshots,
            "action_results": action_results,
            "report_file": str(report_file),
            "total_actions": len(actions),
            "successful_actions": sum(1 for r in action_results if r.get("success"))
        }
        
        print(f"RESULT: {result}")
        return result
        
    except Exception as e:
        ctx.log.error(f"任务执行失败: {str(e)}")
        error_result = {
            "success": False,
            "error": str(e),
            "output_dir": str(output_path),
            "screenshots": screenshots
        }
        print(f"RESULT: {error_result}")
        return error_result


if __name__ == "__main__":
    main()