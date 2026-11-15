/**
 * P1-3「产物库」纯函数回归：扩展名判定 / 预览分级 / 来源执行深链。
 */
import { describe, it, expect } from 'vitest';
import {
  artifactExtension,
  isPreviewableImage,
  isPreviewableText,
  previewKind,
  executionDeepLink,
} from '../utils/artifactLibrary';

describe('artifactExtension', () => {
  it('取小写扩展名，无点返回空串', () => {
    expect(artifactExtension('report.CSV')).toBe('csv');
    expect(artifactExtension('screenshot.PNG')).toBe('png');
    expect(artifactExtension('README')).toBe('');
    expect(artifactExtension('archive.tar.gz')).toBe('gz');
    expect(artifactExtension('.gitignore')).toBe('');
  });
});

describe('previewKind 分级', () => {
  it('图片 → image', () => {
    expect(previewKind('a.png')).toBe('image');
    expect(previewKind('b.JPG')).toBe('image');
    expect(isPreviewableImage('c.webp')).toBe(true);
  });

  it('文本类 → text', () => {
    expect(previewKind('run.log')).toBe('text');
    expect(previewKind('data.json')).toBe('text');
    expect(isPreviewableText('notes.md')).toBe(true);
  });

  it('二进制/压缩包/未知后缀 → none', () => {
    expect(previewKind('model.zip')).toBe('none');
    expect(previewKind('build.exe')).toBe('none');
    expect(previewKind('noext')).toBe('none');
  });
});

describe('executionDeepLink', () => {
  it('拼任务 → 执行详情深链', () => {
    expect(
      executionDeepLink({ taskId: 't-1', executionId: 'exec-9' }),
    ).toBe('/tasks/t-1/executions/exec-9');
  });
});
