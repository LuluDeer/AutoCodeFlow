"""
系统集成自动化示例任务
功能：启动/停止应用程序、进程管理、系统监控
依赖：pip install psutil
"""
import subprocess
import time
import signal
import platform
import psutil
from pathlib import Path
from datetime import datetime
from autoflow_sdk import TaskContext
import json


def get_system_info():
    """获取系统信息"""
    return {
        "platform": platform.system(),
        "platform_release": platform.release(),
        "platform_version": platform.version(),
        "architecture": platform.machine(),
        "hostname": platform.node(),
        "processor": platform.processor(),
        "python_version": platform.python_version()
    }


def get_process_info(process):
    """获取进程详细信息"""
    try:
        return {
            "pid": process.pid,
            "name": process.name(),
            "status": process.status(),
            "cpu_percent": process.cpu_percent(interval=0.1),
            "memory_mb": round(process.memory_info().rss / 1024 / 1024, 2),
            "create_time": datetime.fromtimestamp(process.create_time()).isoformat(),
            "exe": process.exe(),
            "cmdline": process.cmdline(),
            "cwd": process.cwd()
        }
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return None


def main():
    ctx = TaskContext.from_env()
    
    # 获取任务参数
    operations = ctx.get_param("operations", [])
    timeout = ctx.get_param("timeout", 30)
    output_dir = ctx.get_param("outputDir", f"/tmp/system_automation_{ctx.execution_id}")
    
    ctx.log.info("开始系统集成自动化任务")
    
    # 创建输出目录
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # 获取系统信息
    system_info = get_system_info()
    ctx.log.info(f"系统信息: {system_info['platform']} {system_info['platform_release']}")
    
    # 执行操作
    operation_results = []
    process_snapshots = []
    
    for i, operation in enumerate(operations):
        op_type = operation.get("type")
        ctx.log.info(f"执行操作 {i+1}/{len(operations)}: {op_type}")
        
        result = {"operation": op_type, "success": True, "timestamp": datetime.now().isoformat()}
        
        try:
            if op_type == "start_application":
                app_path = operation.get("appPath")
                args = operation.get("args", [])
                working_dir = operation.get("workingDir")
                wait = operation.get("wait", False)
                capture_output = operation.get("captureOutput", True)
                
                if not app_path or not Path(app_path).exists():
                    raise FileNotFoundError(f"应用程序不存在: {app_path}")
                
                cmd = [app_path] + args
                cwd = working_dir if working_dir else None
                
                if capture_output:
                    process = subprocess.Popen(
                        cmd,
                        cwd=cwd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True
                    )
                else:
                    process = subprocess.Popen(cmd, cwd=cwd)
                
                result["pid"] = process.pid
                result["command"] = " ".join(cmd)
                
                if wait:
                    try:
                        stdout, stderr = process.communicate(timeout=timeout)
                        result["return_code"] = process.returncode
                        result["stdout"] = stdout if capture_output else None
                        result["stderr"] = stderr if capture_output else None
                    except subprocess.TimeoutExpired:
                        process.kill()
                        result["timeout"] = True
                        result["error"] = f"进程超时 ({timeout}s)"
                        result["success"] = False
                else:
                    # 等待一小段时间确保进程启动
                    time.sleep(2)
                    if psutil.pid_exists(process.pid):
                        proc_info = get_process_info(psutil.Process(process.pid))
                        result["process_info"] = proc_info
                    else:
                        result["success"] = False
                        result["error"] = "进程启动后立即退出"
                
                ctx.log.info(f"应用程序已启动: PID {process.pid}")
                
            elif op_type == "stop_application":
                pid = operation.get("pid")
                app_name = operation.get("appName")
                force = operation.get("force", False)
                
                if pid:
                    # 通过PID停止
                    try:
                        process = psutil.Process(pid)
                        if force:
                            process.kill()
                        else:
                            process.terminate()
                        
                        process.wait(timeout=10)
                        result["pid"] = pid
                        result["method"] = "pid" if force else "terminate"
                    except psutil.NoSuchProcess:
                        result["success"] = False
                        result["error"] = f"进程不存在: {pid}"
                    except psutil.TimeoutExpired:
                        process.kill()
                        result["force_killed"] = True
                        
                elif app_name:
                    # 通过应用名称停止
                    stopped_processes = []
                    for proc in psutil.process_iter(['pid', 'name']):
                        if app_name.lower() in proc.info['name'].lower():
                            try:
                                if force:
                                    proc.kill()
                                else:
                                    proc.terminate()
                                stopped_processes.append(proc.info['pid'])
                            except (psutil.NoSuchProcess, psutil.AccessDenied):
                                pass
                    
                    result["stopped_pids"] = stopped_processes
                    result["count"] = len(stopped_processes)
                    
                    if not stopped_processes:
                        result["success"] = False
                        result["error"] = f"未找到运行中的进程: {app_name}"
                else:
                    result["success"] = False
                    result["error"] = "必须指定 pid 或 appName"
                
                ctx.log.info(f"应用程序已停止")
                
            elif op_type == "list_processes":
                name_filter = operation.get("nameFilter", "")
                limit = operation.get("limit", 20)
                
                processes = []
                for proc in psutil.process_iter(['pid', 'name']):
                    try:
                        if not name_filter or name_filter.lower() in proc.info['name'].lower():
                            process = psutil.Process(proc.info['pid'])
                            proc_info = get_process_info(process)
                            if proc_info:
                                processes.append(proc_info)
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                        pass
                
                # 按CPU使用率排序
                processes.sort(key=lambda x: x.get('cpu_percent', 0), reverse=True)
                processes = processes[:limit]
                
                result["processes"] = processes
                result["count"] = len(processes)
                
            elif op_type == "monitor_system":
                duration = operation.get("duration", 10)
                interval = operation.get("interval", 2)
                
                metrics = []
                start_time = time.time()
                
                while time.time() - start_time < duration:
                    # CPU信息
                    cpu_percent = psutil.cpu_percent(interval=0.1)
                    cpu_count = psutil.cpu_count()
                    cpu_freq = psutil.cpu_freq()
                    
                    # 内存信息
                    memory = psutil.virtual_memory()
                    
                    # 磁盘信息
                    disk = psutil.disk_usage('/')
                    
                    # 网络信息
                    net = psutil.net_io_counters()
                    
                    metric = {
                        "timestamp": datetime.now().isoformat(),
                        "cpu": {
                            "percent": cpu_percent,
                            "count": cpu_count,
                            "frequency_mhz": cpu_freq.current if cpu_freq else None
                        },
                        "memory": {
                            "total_gb": round(memory.total / 1024**3, 2),
                            "available_gb": round(memory.available / 1024**3, 2),
                            "percent": memory.percent,
                            "used_gb": round(memory.used / 1024**3, 2)
                        },
                        "disk": {
                            "total_gb": round(disk.total / 1024**3, 2),
                            "used_gb": round(disk.used / 1024**3, 2),
                            "free_gb": round(disk.free / 1024**3, 2),
                            "percent": disk.percent
                        },
                        "network": {
                            "bytes_sent": net.bytes_sent,
                            "bytes_recv": net.bytes_recv,
                            "packets_sent": net.packets_sent,
                            "packets_recv": net.packets_recv
                        }
                    }
                    
                    metrics.append(metric)
                    process_snapshots.append(metric)
                    time.sleep(interval)
                
                result["metrics"] = metrics
                result["duration": duration
                result["sample_count"] = len(metrics)
                
            elif op_type == "execute_command":
                command = operation.get("command")
                shell = operation.get("shell", False)
                working_dir = operation.get("workingDir")
                timeout = operation.get("timeout", 30)
                
                if not command:
                    raise ValueError("命令不能为空")
                
                cwd = working_dir if working_dir else None
                
                try:
                    completed = subprocess.run(
                        command,
                        shell=shell,
                        cwd=cwd,
                        capture_output=True,
                        text=True,
                        timeout=timeout
                    )
                    
                    result["command"] = command
                    result["return_code"] = completed.returncode
                    result["stdout"] = completed.stdout
                    result["stderr"] = completed.stderr
                    result["success"] = completed.returncode == 0
                    
                    if completed.returncode != 0:
                        result["error"] = f"命令执行失败，返回码: {completed.returncode}"
                        
                except subprocess.TimeoutExpired:
                    result["success"] = False
                    result["error"] = f"命令执行超时 ({timeout}s)"
                    result["timeout"] = True
                except Exception as e:
                    result["success"] = False
                    result["error"] = str(e)
                
            elif op_type == "kill_zombie_processes":
                killed_count = 0
                for proc in psutil.process_iter(['pid', 'name', 'status']):
                    try:
                        if proc.info['status'] == psutil.STATUS_ZOMBIE:
                            proc.kill()
                            killed_count += 1
                            ctx.log.info(f"已杀死僵尸进程: PID {proc.info['pid']}")
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                
                result["killed_count"] = killed_count
                
            elif op_type == "check_port":
                port = operation.get("port")
                if not port:
                    raise ValueError("端口号不能为空")
                
                port_in_use = False
                process_info = None
                
                for conn in psutil.net_connections():
                    if conn.laddr.port == port and conn.status == 'LISTEN':
                        port_in_use = True
                        try:
                            process = psutil.Process(conn.pid)
                            process_info = get_process_info(process)
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            process_info = {"pid": conn.pid}
                        break
                
                result["port"] = port
                result["in_use"] = port_in_use
                result["process"] = process_info
                
            elif op_type == "take_screenshot":
                # 跨平台截图
                screenshot_path = output_path / f"screenshot_{int(time.time())}.png"
                
                try:
                    if system_info["platform"] == "Darwin":  # macOS
                        subprocess.run(["screencapture", "-x", str(screenshot_path)], check=True)
                    elif system_info["platform"] == "Windows":
                        # 需要安装 pyautogui 或其他截图库
                        import pyautogui
                        pyautogui.screenshot(str(screenshot_path))
                    else:  # Linux
                        # 需要安装 scrot 或其他截图工具
                        subprocess.run(["scrot", str(screenshot_path)], check=True)
                    
                    result["screenshot_path"] = str(screenshot_path)
                    result["size_bytes"] = screenshot_path.stat().st_size if screenshot_path.exists() else 0
                    
                except Exception as e:
                    result["success"] = False
                    result["error"] = f"截图失败: {str(e)}"
                    result["hint"] = "可能需要安装额外的截图工具"
                
            elif op_type == "send_notification":
                title = operation.get("title", "AutoCodeFlow 通知")
                message = operation.get("message", "")
                sound = operation.get("sound", True)
                
                try:
                    if system_info["platform"] == "Darwin":  # macOS
                        cmd = ["osascript", "-e", f'display notification "{message}" with title "{title}"']
                        if sound:
                            cmd.append("sound name \"Glass\"")
                        subprocess.run(cmd, check=True)
                        
                    elif system_info["platform"] == "Windows":
                        # Windows 使用 toast 通知
                        from win10toast import ToastNotifier
                        toaster = ToastNotifier()
                        toaster.show_toast(title, message, duration=5, threaded=True)
                        
                    else:  # Linux
                        # Linux 使用 notify-send
                        subprocess.run(["notify-send", title, message], check=True)
                    
                    result["title"] = title
                    result["message"] = message
                    
                except Exception as e:
                    result["success"] = False
                    result["error"] = f"发送通知失败: {str(e)}"
                    result["hint"] = "可能需要安装通知工具"
                
            else:
                result["success"] = False
                result["error"] = f"未知操作类型: {op_type}"
            
        except Exception as e:
            result["success"] = False
            result["error"] = str(e)
            ctx.log.error(f"操作失败: {str(e)}")
        
        operation_results.append(result)
    
    # 生成操作报告
    report_file = output_path / "system_automation_report.json"
    report = {
        "execution_id": ctx.execution_id,
        "timestamp": datetime.now().isoformat(),
        "system_info": system_info,
        "operations_performed": len(operation_results),
        "successful_operations": sum(1 for r in operation_results if r.get("success")),
        "operation_results": operation_results,
        "process_snapshots": process_snapshots,
        "summary": {
            "total_operations": len(operation_results),
            "successful_operations": sum(1 for r in operation_results if r.get("success")),
            "failed_operations": sum(1 for r in operation_results if not r.get("success"))
        }
    }
    
    with open(report_file, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    
    ctx.log.info(f"操作报告已保存: {report_file}")
    
    # 返回结果
    result = {
        "success": True,
        "message": "系统集成自动化任务完成",
        "system_info": system_info,
        "output_dir": str(output_path),
        "operations_performed": len(operation_results),
        "successful_operations": sum(1 for r in operation_results if r.get("success")),
        "report_file": str(report_file),
        "operation_results": operation_results
    }
    
    print(f"RESULT: {result}")
    return result


if __name__ == "__main__":
    main()