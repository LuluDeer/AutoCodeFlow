"""
桌面GUI自动化示例任务
功能：鼠标键盘操作、屏幕截图、图像识别，截图作为执行产物（artifacts）上报
依赖：pip install pyautogui pillow opencv-python
"""
import json
import os
import tempfile
import time
from pathlib import Path

import pyautogui

from autoflow_sdk import TaskContext

# 执行器 artifacts 通道上限（与 apps/executor-python/artifacts.py 一致）：
# 最多 20 个文件，超出部分被静默跳过。GUI 任务每个动作都截图会轻易超限，
# 故这里只在预算内落盘，避免"截了一堆图但 UI 只看到前 20 张"的困惑。
MAX_ARTIFACTS = 20


def get_typed_param(ctx, key, default=None):
    """
    JSON 容错解析任务参数。

    执行器把所有触发参数字符串化注入（AUTOFLOW_* 环境变量），python SDK
    from_env 不做类型还原——actions 这类列表参数拿到的其实是字符串，
    直接按列表迭代只会逐字符空转。尝试 json.loads 还原，失败则原样返回
    字符串（对齐 Node 示例 getParam 的兜底语义）。

    另有一处键名陷阱：执行器注入时把键名**大写**（`AUTOFLOW_{k.upper()}`，
    见 apps/executor-python/routers/execute.py），而 SDK 读回时把键名**小写**
    （context.py: params[...lower()]）。于是任务配置里写成 camelCase 的键
    （`screenshotInterval`）在 ctx.params 里只以小写形态（`screenshotinterval`）
    存在，按原样查找恒为 None、静默落回默认值。这里补一次小写回退查找。
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


def resolve_artifacts_dir(ctx) -> Path:
    """产物目录：优先用执行器注入的 AUTOFLOW_ARTIFACTS_DIR（FEAT-05）。

    执行器把该变量指向 <work_dir>/artifacts/ 并已预建目录；任务结束时执行器
    扫描该目录、上传文件、把清单随终态回调上报，用户即可在执行详情页查看。
    本地裸跑（无执行器）时回退到系统临时目录，保持可调试。
    """
    injected = ctx.get_env("AUTOFLOW_ARTIFACTS_DIR") or ctx.get_param("artifacts_dir")
    if injected:
        return Path(injected)
    return Path(tempfile.gettempdir()) / f"desktop_automation_{ctx.execution_id}"


def main():
    ctx = TaskContext.from_env()

    # 获取任务参数（actions 列表经 JSON 容错解析还原，见 helper 注释）
    actions = get_typed_param(ctx, "actions", [])
    if not isinstance(actions, list):
        ctx.log.warning("actions 参数应为 JSON 数组，已按空列表处理")
        actions = []
    screenshot_interval = get_typed_param(ctx, "screenshotInterval", 2)
    if not isinstance(screenshot_interval, (int, float)):
        try:
            screenshot_interval = float(screenshot_interval)
        except (ValueError, TypeError):
            ctx.log.warning(
                f"screenshotInterval 参数非法（{screenshot_interval!r}），已回退 2s"
            )
            screenshot_interval = 2

    output_path = resolve_artifacts_dir(ctx)
    output_path.mkdir(parents=True, exist_ok=True)
    ctx.log.info(f"产物目录: {output_path}")

    ctx.log.info("开始桌面GUI自动化任务")

    # 设置pyautogui安全措施
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 1

    screenshots = []
    action_results = []

    # 初始截图
    initial_screen = output_path / "00_initial_screen.png"
    pyautogui.screenshot(str(initial_screen))
    screenshots.append(initial_screen.name)
    ctx.log.info(f"已保存初始屏幕截图: {initial_screen.name}")

    # 获取屏幕尺寸
    screen_width, screen_height = pyautogui.size()
    ctx.log.info(f"屏幕尺寸: {screen_width}x{screen_height}")

    # 执行动作序列。单个动作失败不中断整体流程——记录后继续（最终以抛异常
    # 与否决定任务成败，见文件末尾说明）。
    for i, action in enumerate(actions):
        action_type = action.get("type")
        ctx.log.info(f"执行动作 {i+1}/{len(actions)}: {action_type}")

        result = {"action": action_type, "success": True}

        try:
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
                # pyautogui.dragTo 从**当前**鼠标位置起拖；先移到起点，
                # 否则 startX/startY 参数实际不生效（拖拽落点偏移）。
                pyautogui.moveTo(start_x, start_y)
                pyautogui.dragTo(end_x, end_y, duration=duration, button="left")
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
                screenshots.append(screenshot_path.name)
                result["file"] = screenshot_path.name

            elif action_type == "find_and_click":
                image_path = action.get("imagePath")
                confidence = action.get("confidence", 0.8)

                if image_path and os.path.exists(image_path):
                    try:
                        location = pyautogui.locateOnScreen(
                            image_path, confidence=confidence
                        )
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

            else:
                raise ValueError(f"未知动作类型: {action_type}")

        except Exception as e:
            result["success"] = False
            result["error"] = str(e)
            ctx.log.error(f"动作 {i+1} ({action_type}) 失败: {e}")

        # 动作后截图（仅在 artifacts 预算内；screenshot 动作本身已截图）
        if action_type != "screenshot":
            time.sleep(0.5)
            if len(screenshots) < MAX_ARTIFACTS - 1:  # 留 1 个名额给最终截图
                action_screenshot = output_path / f"action_{i+1}.png"
                pyautogui.screenshot(str(action_screenshot))
                screenshots.append(action_screenshot.name)

        action_results.append(result)
        time.sleep(screenshot_interval)

    # 最终截图
    final_screen = output_path / "99_final_screen.png"
    pyautogui.screenshot(str(final_screen))
    screenshots.append(final_screen.name)
    ctx.log.info(f"已保存最终屏幕截图: {final_screen.name}")

    # 生成动作报告
    report_file = output_path / "automation_report.txt"
    with open(report_file, "w", encoding="utf-8") as f:
        f.write("桌面GUI自动化任务报告\n")
        f.write("=" * 50 + "\n\n")
        f.write(f"执行ID: {ctx.execution_id}\n")
        f.write(f"屏幕尺寸: {screen_width}x{screen_height}\n")
        f.write(f"动作总数: {len(actions)}\n")
        f.write(f"截图数量: {len(screenshots)}\n\n")

        f.write("动作执行详情:\n")
        f.write("-" * 50 + "\n")
        for i, result in enumerate(action_results, 1):
            status = "OK" if result.get("success") else "NG"
            f.write(f"{i}. [{status}] {result['action']}\n")
            if not result.get("success"):
                f.write(f"   错误: {result.get('error', 'Unknown')}\n")

        f.write("\n截图文件:\n")
        f.write("-" * 50 + "\n")
        for screenshot in screenshots:
            f.write(f"- {screenshot}\n")

    ctx.log.info(f"动作报告已保存: {report_file.name}")

    failed_actions = [r for r in action_results if not r.get("success")]

    # 返回结果。产物文件名以裸名列出（执行器上报的清单用的就是裸名）。
    result = {
        "success": not failed_actions,
        "message": "桌面GUI自动化任务完成",
        "artifacts_dir": str(output_path),
        "screenshots": screenshots,
        "action_results": action_results,
        "report_file": report_file.name,
        "total_actions": len(actions),
        "successful_actions": len(action_results) - len(failed_actions),
    }

    print(f"RESULT: {result}")

    # 有动作失败 → 抛异常让执行器判 FAILED。执行器只看进程退出码，
    # 返回 {"success": False} 不会改变判定（会显示成成功，即"假绿"）。
    if failed_actions:
        raise RuntimeError(
            f"{len(failed_actions)}/{len(action_results)} 个动作执行失败，"
            f"首个错误: {failed_actions[0].get('error')}"
        )

    return result


if __name__ == "__main__":
    main()
