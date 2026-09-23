import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  DEVICE_FINGERPRINT_HEX_LENGTH,
  DEVICE_IDENTITY_DIR_NAME,
  DeviceIdentityResolver,
  computeDeviceFingerprint,
  deviceSaltPath,
  loadOrCreateInstallSalt,
  resolveDeviceId,
  resolveInstanceKind,
  resolveMacHostnameId,
  __resetDefaultDeviceIdentityForTest,
  type DeviceIdentityProbe,
  type DeviceSaltIo,
} from "./device-identity";

const VECTORS_RELATIVE = path.join(
  "packages",
  "executor-protocol",
  "device-identity.vectors.json",
);

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, VECTORS_RELATIVE))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`device-identity.vectors.json not found above ${from}`);
}

// A3 同款理由（protocol-schemas.spec.ts 头注）：不用 resolveJsonModule 跨出 app
// 目录，运行期按路径向上找仓库根——构建期不污染 tsc 编译图，测试期仍与 python
// 侧读**同一份**向量文件。
const vectors = JSON.parse(
  readFileSync(path.join(findRepoRoot(__dirname), VECTORS_RELATIVE), "utf-8"),
) as {
  fingerprintVectors: {
    name: string;
    deviceId: string;
    installSalt: string;
    fingerprint: string;
  }[];
  fallbackVectors: {
    name: string;
    mac: string;
    hostname: string;
    deviceId: string;
  }[];
};

/** 构造假探测面：默认全部失败（等价于"什么都读不到"），按需覆盖。 */
function makeProbe(
  overrides: Partial<DeviceIdentityProbe> = {},
): DeviceIdentityProbe {
  return {
    platform: "linux",
    readTextFile: () => {
      throw new Error("ENOENT");
    },
    runCommand: () => {
      throw new Error("ENOENT");
    },
    hostname: "",
    networkInterfaces: () => ({}),
    ...overrides,
  };
}

/** 记录型盐 IO：默认"文件不存在"，写入进内存 Map。
 *
 * 预置盐的键必须用 `deviceSaltPath` 现算——硬编码 `/wd/.device-identity/node.salt`
 * 在 Windows 上会因 path.join 产出反斜杠而与解析器实际读的键不一致，于是"预置
 * 成功"其实是"读不到 → 重新生成"，测试会以**错误的原因**通过/失败。
 */
function makeSaltIo(
  seed: string | null = null,
  kind = "node",
): {
  io: DeviceSaltIo;
  files: Map<string, string>;
  writes: string[];
  dirs: string[];
} {
  const saltPath = deviceSaltPath("/wd", kind);
  const files = new Map<string, string>();
  if (seed !== null) files.set(saltPath, seed);
  const writes: string[] = [];
  const dirs: string[] = [];
  const io: DeviceSaltIo = {
    readTextFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeTextFile: (p, content) => {
      writes.push(p);
      files.set(p, content);
    },
    makeDir: (d) => {
      dirs.push(d);
    },
    generateSalt: () => "11111111-2222-4333-8444-555555555555",
  };
  return { io, files, writes, dirs };
}

describe("ARCH-36 deviceFingerprint 采集（ADR-017 阶段 2）", () => {
  describe("三端一致性金标向量", () => {
    it("金标向量文件形状正确（防扫描器静默失效）", () => {
      expect(Array.isArray(vectors.fingerprintVectors)).toBe(true);
      expect(vectors.fingerprintVectors.length).toBeGreaterThanOrEqual(3);
      expect(Array.isArray(vectors.fallbackVectors)).toBe(true);
      expect(vectors.fallbackVectors.length).toBeGreaterThanOrEqual(2);
    });

    it.each(vectors.fingerprintVectors)(
      "computeDeviceFingerprint 命中金标向量 $name（与 executor-python 同源）",
      ({ deviceId, installSalt, fingerprint }) => {
        expect(computeDeviceFingerprint(deviceId, installSalt)).toBe(
          fingerprint,
        );
      },
    );

    it.each(vectors.fallbackVectors)(
      "MAC 兜底 deviceId 命中金标向量 $name（与 executor-python 同源）",
      ({ mac, hostname, deviceId }) => {
        expect(
          resolveMacHostnameId(
            makeProbe({
              hostname,
              networkInterfaces: () =>
                mac
                  ? { eth0: [{ mac, internal: false } as never] }
                  : {},
            }),
          ),
        ).toBe(deviceId);
      },
    );

    it("指纹恒为 64 位小写十六进制（admin 侧 varchar(64) 与正则的契约）", () => {
      const fp = computeDeviceFingerprint("any", "salt");
      expect(fp).toHaveLength(DEVICE_FINGERPRINT_HEX_LENGTH);
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    });

    it("deviceId 或盐变化 → 指纹必变（唯一性判据的前提）", () => {
      const base = computeDeviceFingerprint("dev-a", "salt-a");
      expect(computeDeviceFingerprint("dev-b", "salt-a")).not.toBe(base);
      expect(computeDeviceFingerprint("dev-a", "salt-b")).not.toBe(base);
      // 刻意**不**断言「拼接无歧义」（如 fp("a:b","c") !== fp("a","b:c")）：
      // 形如 `deviceId + ":" + salt` 的拼接本来就有歧义，实现也不打算防它。
      // 前提由**成分形态**保证：deviceId 是 UUID / 32 位十六进制 machine-id /
      // 十六进制哈希，installSalt 是 UUID——都不可能含 ':'。见
      // `computeDeviceFingerprint` 的注释；新增 deviceId 来源时必须复核该前提。
    });
  });

  describe("resolveDeviceId 三平台取值与兜底", () => {
    it("Windows 走 MachineGuid（从 reg query 输出里取 REG_SZ 值）", () => {
      const result = resolveDeviceId(
        makeProbe({
          platform: "win32",
          runCommand: (file, args) => {
            expect(file).toBe("reg");
            expect(args).toContain("MachineGuid");
            return "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n" +
              "    MachineGuid    REG_SZ    4c4c4544-0044-5910-8038-b7c04f4d4a32\r\n\r\n";
          },
        }),
      );
      expect(result).toEqual({
        id: "4c4c4544-0044-5910-8038-b7c04f4d4a32",
        source: "windows-machine-guid",
      });
    });

    it("Windows 注册表读不到 → 落到 MAC/主机名兜底（不抛错）", () => {
      const result = resolveDeviceId(
        makeProbe({ platform: "win32", hostname: "win-host" }),
      );
      expect(result?.source).toBe("mac-hostname-fallback");
      expect(result?.id).toBe(
        resolveMacHostnameId(makeProbe({ hostname: "win-host" })),
      );
    });

    it("Linux 优先 /etc/machine-id", () => {
      const result = resolveDeviceId(
        makeProbe({
          platform: "linux",
          readTextFile: (p) => {
            if (p === "/etc/machine-id") return "  d3f8b1c2e4a5f60718293a4b5c6d7e8f\n";
            throw new Error("ENOENT");
          },
        }),
      );
      expect(result).toEqual({
        id: "d3f8b1c2e4a5f60718293a4b5c6d7e8f",
        source: "linux-machine-id",
      });
    });

    it("Linux /etc/machine-id 缺失 → 回退 /var/lib/dbus/machine-id", () => {
      const result = resolveDeviceId(
        makeProbe({
          platform: "linux",
          readTextFile: (p) => {
            if (p === "/var/lib/dbus/machine-id") return "dbus-machine-id-value\n";
            throw new Error("ENOENT");
          },
        }),
      );
      expect(result).toEqual({
        id: "dbus-machine-id-value",
        source: "linux-dbus-machine-id",
      });
    });

    it("Linux /etc/machine-id 为空文件（容器常见）→ 视同不可得", () => {
      const result = resolveDeviceId(
        makeProbe({
          platform: "linux",
          readTextFile: (p) => (p === "/etc/machine-id" ? "   \n" : ""),
          hostname: "container-1",
        }),
      );
      expect(result?.source).toBe("mac-hostname-fallback");
    });

    it("macOS 从 ioreg 输出里取 IOPlatformUUID", () => {
      const result = resolveDeviceId(
        makeProbe({
          platform: "darwin",
          runCommand: (file, args) => {
            expect(file).toBe("ioreg");
            expect(args).toContain("IOPlatformExpertDevice");
            return '    "IOPlatformUUID" = "IOPlatformUUID-EXAMPLE-0001"\n';
          },
        }),
      );
      expect(result).toEqual({
        id: "IOPlatformUUID-EXAMPLE-0001",
        source: "darwin-platform-uuid",
      });
    });

    it("全部手段失败且无主机名/网卡 → null（fail-open 的调用方见 0 上报）", () => {
      expect(resolveDeviceId(makeProbe({ platform: "freebsd" }))).toBeNull();
    });

    it("网络接口枚举抛错也走兜底而非抛出（兜底路径不得失败）", () => {
      const result = resolveDeviceId(
        makeProbe({
          platform: "freebsd",
          hostname: "weird-host",
          networkInterfaces: () => {
            throw new Error("EPERM");
          },
        }),
      );
      expect(result?.source).toBe("mac-hostname-fallback");
    });

    it("跳过 internal 与全零 MAC，取排序后首个可用网卡", () => {
      const result = resolveMacHostnameId(
        makeProbe({
          hostname: "h",
          networkInterfaces: () => ({
            zz9: [{ mac: "aa:bb:cc:dd:ee:01", internal: false } as never],
            lo: [{ mac: "00:00:00:00:00:00", internal: false } as never],
            eth0: [
              { mac: "AA:BB:CC:DD:EE:00", internal: false } as never, // 归一化为小写
            ],
          }),
        }),
      );
      // eth0 排序在前 → 取它，且 MAC 转小写
      expect(result).toBe(
        resolveMacHostnameId(
          makeProbe({
            hostname: "h",
            networkInterfaces: () => ({
              eth0: [{ mac: "aa:bb:cc:dd:ee:00", internal: false } as never],
            }),
          }),
        ),
      );
    });
  });

  describe("安装实例盐持久化", () => {
    // 路径一律用 deviceSaltPath 现算，不硬编码——见 makeSaltIo 的头注（Windows
    // 分隔符差异会让"预置成功"实为"读不到→重建"）。
    const saltPath = deviceSaltPath("/wd", "node");

    it("已有合法盐 → 复用，不写盘", () => {
      const { io, writes, dirs } = makeSaltIo(
        "8f14e45f-ceea-467a-9ae0-1a1c2b3d4e5f\n",
      );
      const result = loadOrCreateInstallSalt(saltPath, io);
      expect(result).toEqual({
        salt: "8f14e45f-ceea-467a-9ae0-1a1c2b3d4e5f",
        created: false,
      });
      expect(writes).toEqual([]);
      expect(dirs).toEqual([]);
    });

    it("文件缺失 → 生成新盐、建目录、写盘", () => {
      const { io, writes, dirs } = makeSaltIo();
      const result = loadOrCreateInstallSalt(saltPath, io);
      expect(result.created).toBe(true);
      expect(result.salt).toBe("11111111-2222-4333-8444-555555555555");
      expect(writes).toEqual([saltPath]);
      expect(dirs).toEqual([path.dirname(saltPath)]);
    });

    it("盐文件被截断/写成垃圾 → 重建（不采信非法值）", () => {
      for (const bad of ["", "   ", "not-a-uuid", "8f14e45f-ceea-467a"]) {
        const { io } = makeSaltIo(bad);
        const result = loadOrCreateInstallSalt(saltPath, io);
        expect(result.created).toBe(true);
        expect(result.salt).toBe("11111111-2222-4333-8444-555555555555");
      }
    });

    it("盐路径含 kind 分域，且落在受保护的 .device-identity 目录下", () => {
      const p = deviceSaltPath("/data/tasks", "python");
      expect(p).toBe(
        path.join("/data/tasks", DEVICE_IDENTITY_DIR_NAME, "python.salt"),
      );
      // 目录名是 file-logger 的 PROTECTED_WORKDIR_NAMES 之一；此处只钉前缀，
      // 与清扫保护名的绑定由 file-logger 侧用例断言。
      expect(p).toContain(`${path.sep}${DEVICE_IDENTITY_DIR_NAME}${path.sep}`);
    });
  });

  describe("DeviceIdentityResolver（实例，无模块级状态）", () => {
    const workDir = () => "/wd";

    it("解析成功 → 64 位十六进制，且复用 memo（探测只跑一次）", () => {
      let reads = 0;
      const { io } = makeSaltIo("8f14e45f-ceea-467a-9ae0-1a1c2b3d4e5f");
      const resolver = new DeviceIdentityResolver({
        workDir,
        kind: "node",
        probe: makeProbe({
          platform: "linux",
          readTextFile: () => {
            reads += 1;
            return "d3f8b1c2e4a5f60718293a4b5c6d7e8f\n";
          },
        }),
        saltIo: io,
      });
      const first = resolver.resolve();
      const second = resolver.resolve();
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(second).toBe(first);
      expect(reads).toBe(1);
    });

    it("指纹 = 金标算法（与 python 侧同源）", () => {
      const { io } = makeSaltIo("8f14e45f-ceea-467a-9ae0-1a1c2b3d4e5f");
      const resolver = new DeviceIdentityResolver({
        workDir,
        kind: "node",
        probe: makeProbe({
          platform: "linux",
          readTextFile: () => "4c4c4544-0044-5910-8038-b7c04f4d4a32\n",
        }),
        saltIo: io,
      });
      expect(resolver.resolve()).toBe(
        vectors.fingerprintVectors[0].fingerprint,
      );
    });

    it("设备不可识别 → null（不抛错，注册照常）", () => {
      const { io } = makeSaltIo();
      const resolver = new DeviceIdentityResolver({
        workDir,
        kind: "node",
        probe: makeProbe({ platform: "freebsd" }),
        saltIo: io,
      });
      expect(resolver.resolve()).toBeNull();
      // 失败同样 memo：不重复探测，也不重复 warn。
      expect(resolver.resolve()).toBeNull();
    });

    it("探测抛异常 → fail-open 返回 null 且不冒泡", () => {
      const { io } = makeSaltIo();
      const resolver = new DeviceIdentityResolver({
        workDir,
        kind: "node",
        probe: makeProbe({
          platform: "linux",
          readTextFile: () => {
            throw new Error("EACCES: /etc/machine-id");
          },
          hostname: "",
          networkInterfaces: () => {
            throw new Error("EPERM");
          },
        }),
        saltIo: io,
      });
      expect(() => resolver.resolve()).not.toThrow();
      expect(resolver.resolve()).toBeNull();
    });

    it("盐写盘失败（数据目录只读）→ fail-open 返回 null", () => {
      const resolver = new DeviceIdentityResolver({
        workDir,
        kind: "node",
        probe: makeProbe({
          platform: "linux",
          readTextFile: () => "machine-id-x\n",
        }),
        saltIo: {
          readTextFile: () => {
            throw new Error("ENOENT");
          },
          writeTextFile: () => {
            throw new Error("EROFS: read-only file system");
          },
          makeDir: () => {
            throw new Error("EROFS: read-only file system");
          },
          generateSalt: () => "11111111-2222-4333-8444-555555555555",
        },
      });
      expect(resolver.resolve()).toBeNull();
    });

    it("kind 分域落在**盐文件**上：node 与 python 读写各自独立的盐", () => {
      const probe = makeProbe({
        platform: "linux",
        readTextFile: () => "machine-id-x\n",
      });
      const nodeIo = makeSaltIo();
      const pythonIo = makeSaltIo(null, "python");
      new DeviceIdentityResolver({
        workDir,
        kind: "node",
        probe,
        saltIo: nodeIo.io,
      }).resolve();
      new DeviceIdentityResolver({
        workDir,
        kind: "python",
        probe,
        saltIo: pythonIo.io,
      }).resolve();

      // 这是本测试真正要钉的机制：两个 kind 的盐来自**不同文件**，因此现实中
      // 它们拿到的是两次独立的 randomUUID()，指纹必然不同——ADR-017 阶段 3 以
      // 指纹为定位键时，同机同 workDir 的 node 与 python 执行器不会被折叠成一行。
      //
      // 刻意**不**断言「两次 resolve() 的指纹不同」：本 mock 的 generateSalt 是
      // 固定值（测试可确定性所需），两个 kind 会拿到同一个盐，指纹自然相同——
      // 那反映的是 mock 的形态而非实现的缺陷。真正的随机性由 randomUUID 提供，
      // 一处测不到就该由「盐文件不同」这条可判定的机制来钉。
      expect(nodeIo.writes).toEqual([deviceSaltPath("/wd", "node")]);
      expect(pythonIo.writes).toEqual([deviceSaltPath("/wd", "python")]);
      expect(nodeIo.writes).not.toEqual(pythonIo.writes);
    });

    it("kind 缺省按进程形态推断：node（非 electron）", () => {
      // 测试进程里 process.versions.electron 不存在 → 'node'
      expect(resolveInstanceKind()).toBe("node");
    });

    it("EXECUTOR_INSTANCE_KIND 覆盖生效，且空串视为未设置", () => {
      const original = process.env.EXECUTOR_INSTANCE_KIND;
      try {
        process.env.EXECUTOR_INSTANCE_KIND = "custom-kind";
        expect(resolveInstanceKind()).toBe("custom-kind");
        process.env.EXECUTOR_INSTANCE_KIND = "   ";
        expect(resolveInstanceKind()).toBe("node");
      } finally {
        if (original === undefined) delete process.env.EXECUTOR_INSTANCE_KIND;
        else process.env.EXECUTOR_INSTANCE_KIND = original;
      }
    });

    it("测试出口可丢弃默认解析器（防 memo 跨用例泄漏）", () => {
      expect(() => __resetDefaultDeviceIdentityForTest()).not.toThrow();
    });
  });
});
