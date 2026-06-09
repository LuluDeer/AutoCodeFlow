"""
文件系统自动化示例任务
功能：批量文件操作、目录管理、文件监控
依赖：无额外依赖（使用标准库）
"""
import os
import shutil
import time
import hashlib
from pathlib import Path
from datetime import datetime
from autoflow_sdk import TaskContext
import json


def calculate_file_hash(file_path, algorithm='md5'):
    """计算文件哈希值"""
    hash_func = hashlib.new(algorithm)
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(4096), b''):
            hash_func.update(chunk)
    return hash_func.hexdigest()


def get_file_info(file_path):
    """获取文件详细信息"""
    stat = file_path.stat()
    return {
        "name": file_path.name,
        "path": str(file_path),
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
        "extension": file_path.suffix,
        "hash": calculate_file_hash(file_path) if file_path.is_file() else None
    }


def main():
    ctx = TaskContext.from_env()
    
    # 获取任务参数
    source_dir = ctx.get_param("sourceDir", "/tmp/file_automation_source")
    target_dir = ctx.get_param("targetDir", "/tmp/file_automation_target")
    operations = ctx.get_param("operations", [])
    create_test_files = ctx.get_param("createTestFiles", True)
    
    ctx.log.info("开始文件系统自动化任务")
    ctx.log.info(f"源目录: {source_dir}")
    ctx.log.info(f"目标目录: {target_dir}")
    
    # 创建路径对象
    source_path = Path(source_dir)
    target_path = Path(target_dir)
    
    # 创建测试文件（如果需要）
    if create_test_files:
        ctx.log.info("创建测试文件...")
        source_path.mkdir(parents=True, exist_ok=True)
        
        # 创建各种类型的测试文件
        test_files = [
            ("document1.txt", "这是测试文档1的内容"),
            ("document2.txt", "这是测试文档2的内容"),
            ("data.json", json.dumps({"key": "value", "numbers": [1, 2, 3]}, ensure_ascii=False)),
            ("config.yaml", "setting1: value1\nsetting2: value2"),
            ("image.png", b"fake_image_data"),  # 假图片数据
        ]
        
        for filename, content in test_files:
            file_path = source_path / filename
            if isinstance(content, str):
                file_path.write_text(content, encoding='utf-8')
            else:
                file_path.write_bytes(content)
            ctx.log.info(f"创建测试文件: {filename}")
    
    # 确保目标目录存在
    target_path.mkdir(parents=True, exist_ok=True)
    
    # 执行文件操作
    operation_results = []
    file_changes = []
    
    for i, operation in enumerate(operations):
        op_type = operation.get("type")
        ctx.log.info(f"执行操作 {i+1}/{len(operations)}: {op_type}")
        
        result = {"operation": op_type, "success": True, "timestamp": datetime.now().isoformat()}
        
        try:
            if op_type == "list_files":
                pattern = operation.get("pattern", "*")
                recursive = operation.get("recursive", False)
                
                if recursive:
                    files = list(source_path.rglob(pattern))
                else:
                    files = list(source_path.glob(pattern))
                
                file_infos = [get_file_info(f) for f in files if f.is_file()]
                result["files"] = file_infos
                result["count"] = len(file_infos)
                
            elif op_type == "copy_files":
                pattern = operation.get("pattern", "*")
                preserve_structure = operation.get("preserveStructure", False)
                
                files = list(source_path.glob(pattern))
                copied_files = []
                
                for file_path in files:
                    if file_path.is_file():
                        if preserve_structure:
                            # 保持目录结构
                            rel_path = file_path.relative_to(source_path)
                            dest_file = target_path / rel_path
                            dest_file.parent.mkdir(parents=True, exist_ok=True)
                        else:
                            # 扁平化复制
                            dest_file = target_path / file_path.name
                        
                        shutil.copy2(file_path, dest_file)
                        copied_files.append({
                            "source": str(file_path),
                            "destination": str(dest_file),
                            "size": file_path.stat().st_size
                        })
                        
                        file_changes.append({
                            "action": "copy",
                            "file": str(file_path),
                            "destination": str(dest_file)
                        })
                
                result["copied_files"] = copied_files
                result["count"] = len(copied_files)
                
            elif op_type == "move_files":
                pattern = operation.get("pattern", "*")
                
                files = list(source_path.glob(pattern))
                moved_files = []
                
                for file_path in files:
                    if file_path.is_file():
                        dest_file = target_path / file_path.name
                        shutil.move(str(file_path), dest_file)
                        moved_files.append({
                            "source": str(file_path),
                            "destination": str(dest_file)
                        })
                        
                        file_changes.append({
                            "action": "move",
                            "file": str(file_path),
                            "destination": str(dest_file)
                        })
                
                result["moved_files"] = moved_files
                result["count"] = len(moved_files)
                
            elif op_type == "delete_files":
                pattern = operation.get("pattern", "*")
                min_size = operation.get("minSize", 0)  # 字节
                max_age_days = operation.get("maxAgeDays", 0)
                
                files = list(source_path.glob(pattern))
                deleted_files = []
                
                for file_path in files:
                    if file_path.is_file():
                        file_stat = file_path.stat()
                        should_delete = True
                        
                        # 检查文件大小
                        if file_stat.st_size < min_size:
                            should_delete = False
                        
                        # 检查文件年龄
                        if max_age_days > 0:
                            file_age = (time.time() - file_stat.st_mtime) / 86400  # 转换为天数
                            if file_age < max_age_days:
                                should_delete = False
                        
                        if should_delete:
                            file_path.unlink()
                            deleted_files.append({
                                "file": str(file_path),
                                "size": file_stat.st_size
                            })
                            
                            file_changes.append({
                                "action": "delete",
                                "file": str(file_path)
                            })
                
                result["deleted_files"] = deleted_files
                result["count"] = len(deleted_files)
                
            elif op_type == "rename_files":
                pattern = operation.get("pattern", "*")
                prefix = operation.get("prefix", "")
                suffix = operation.get("suffix", "")
                replace_pattern = operation.get("replacePattern")
                replace_with = operation.get("replaceWith", "")
                
                files = list(source_path.glob(pattern))
                renamed_files = []
                
                for file_path in files:
                    if file_path.is_file():
                        old_name = file_path.stem
                        old_ext = file_path.suffix
                        
                        # 应用替换规则
                        new_name = old_name
                        if replace_pattern:
                            new_name = new_name.replace(replace_pattern, replace_with)
                        
                        # 添加前缀和后缀
                        new_name = f"{prefix}{new_name}{suffix}{old_ext}"
                        new_path = file_path.parent / new_name
                        
                        # 避免文件名冲突
                        counter = 1
                        while new_path.exists():
                            new_name = f"{prefix}{old_name}{suffix}_{counter}{old_ext}"
                            new_path = file_path.parent / new_name
                            counter += 1
                        
                        file_path.rename(new_path)
                        renamed_files.append({
                            "old_name": file_path.name,
                            "new_name": new_name
                        })
                        
                        file_changes.append({
                            "action": "rename",
                            "file": str(file_path),
                            "new_name": new_name
                        })
                
                result["renamed_files"] = renamed_files
                result["count"] = len(renamed_files)
                
            elif op_type == "create_directories":
                dirs = operation.get("directories", [])
                base_path = Path(operation.get("basePath", str(target_path)))
                
                created_dirs = []
                for dir_name in dirs:
                    dir_path = base_path / dir_name
                    dir_path.mkdir(parents=True, exist_ok=True)
                    created_dirs.append(str(dir_path))
                    
                    file_changes.append({
                        "action": "create_directory",
                        "path": str(dir_path)
                    })
                
                result["created_directories"] = created_dirs
                result["count"] = len(created_dirs)
                
            elif op_type == "compress_files":
                pattern = operation.get("pattern", "*")
                archive_name = operation.get("archiveName", f"archive_{int(time.time())}.zip")
                archive_format = operation.get("format", "zip")  # zip, tar, gztar
                
                files = list(source_path.glob(pattern))
                archive_path = target_path / archive_name
                
                if archive_format == "zip":
                    shutil.make_archive(
                        str(archive_path.with_suffix('')),
                        'zip',
                        str(source_path),
                        [f.name for f in files if f.is_file()]
                    )
                else:
                    shutil.make_archive(
                        str(archive_path.with_suffix('')),
                        archive_format,
                        str(source_path),
                        [f.name for f in files if f.is_file()]
                    )
                
                result["archive_path"] = str(archive_path)
                result["file_count"] = len([f for f in files if f.is_file()])
                
                file_changes.append({
                    "action": "compress",
                    "archive": str(archive_path),
                    "files": [str(f) for f in files if f.is_file()]
                })
                
            elif op_type == "analyze_directory":
                target = Path(operation.get("path", str(source_path)))
                
                total_size = 0
                file_count = 0
                dir_count = 0
                extension_counts = {}
                largest_files = []
                
                for item in target.rglob("*"):
                    if item.is_file():
                        size = item.stat().st_size
                        total_size += size
                        file_count += 1
                        
                        # 统计扩展名
                        ext = item.suffix.lower()
                        extension_counts[ext] = extension_counts.get(ext, 0) + 1
                        
                        # 记录大文件
                        largest_files.append({
                            "path": str(item),
                            "size": size
                        })
                    elif item.is_dir():
                        dir_count += 1
                
                # 排序并取前10个最大文件
                largest_files.sort(key=lambda x: x["size"], reverse=True)
                largest_files = largest_files[:10]
                
                result["analysis"] = {
                    "total_size": total_size,
                    "total_size_mb": round(total_size / (1024 * 1024), 2),
                    "file_count": file_count,
                    "directory_count": dir_count,
                    "extension_distribution": extension_counts,
                    "largest_files": largest_files
                }
                
            elif op_type == "sync_directories":
                sync_source = Path(operation.get("source", str(source_path)))
                sync_target = Path(operation.get("target", str(target_path)))
                delete_extra = operation.get("deleteExtra", False)
                
                sync_actions = []
                
                # 复制新文件和更新的文件
                for source_file in sync_source.rglob("*"):
                    if source_file.is_file():
                        rel_path = source_file.relative_to(sync_source)
                        target_file = sync_target / rel_path
                        
                        if not target_file.exists():
                            # 新文件
                            target_file.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(source_file, target_file)
                            sync_actions.append({
                                "action": "copy",
                                "file": str(source_file),
                                "reason": "new_file"
                            })
                        elif source_file.stat().st_mtime > target_file.stat().st_mtime:
                            # 更新的文件
                            shutil.copy2(source_file, target_file)
                            sync_actions.append({
                                "action": "copy",
                                "file": str(source_file),
                                "reason": "updated"
                            })
                
                # 删除目标目录中多余的文件（如果启用）
                if delete_extra:
                    for target_file in sync_target.rglob("*"):
                        if target_file.is_file():
                            rel_path = target_file.relative_to(sync_target)
                            source_file = sync_source / rel_path
                            
                            if not source_file.exists():
                                target_file.unlink()
                                sync_actions.append({
                                    "action": "delete",
                                    "file": str(target_file),
                                    "reason": "extra_file"
                                })
                
                result["sync_actions"] = sync_actions
                result["synced_count"] = len(sync_actions)
                
            else:
                result["success"] = False
                result["error"] = f"未知操作类型: {op_type}"
            
        except Exception as e:
            result["success"] = False
            result["error"] = str(e)
            ctx.log.error(f"操作失败: {str(e)}")
        
        operation_results.append(result)
    
    # 生成操作报告
    report_file = target_path / "file_automation_report.json"
    report = {
        "execution_id": ctx.execution_id,
        "timestamp": datetime.now().isoformat(),
        "source_directory": str(source_path),
        "target_directory": str(target_path),
        "operations_performed": len(operation_results),
        "successful_operations": sum(1 for r in operation_results if r.get("success")),
        "operation_results": operation_results,
        "file_changes": file_changes,
        "summary": {
            "total_changes": len(file_changes),
            "changes_by_type": {}
        }
    }
    
    # 按类型统计变更
    for change in file_changes:
        action_type = change["action"]
        report["summary"]["changes_by_type"][action_type] = \
            report["summary"]["changes_by_type"].get(action_type, 0) + 1
    
    with open(report_file, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    
    ctx.log.info(f"操作报告已保存: {report_file}")
    
    # 返回结果
    result = {
        "success": True,
        "message": "文件系统自动化任务完成",
        "source_dir": str(source_path),
        "target_dir": str(target_path),
        "operations_performed": len(operation_results),
        "successful_operations": sum(1 for r in operation_results if r.get("success")),
        "total_file_changes": len(file_changes),
        "report_file": str(report_file),
        "operation_results": operation_results
    }
    
    print(f"RESULT: {result}")
    return result


if __name__ == "__main__":
    main()