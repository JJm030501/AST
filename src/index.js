#!/usr/bin/env node
/**
 * JS AST 自动反混淆工具
 *
 * 基于 Babel 的插件化架构，支持多种混淆模式的自动还原。
 * 使用方式:
 *   node src/index.js -i input.js -o output.js
 *   node src/index.js -i input.js -o output.js --plugins string,constant,control,dead,member
 */

const fs = require("fs");
const path = require("path");
const { program } = require("commander");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;
const chalk = require("chalk");
const {
  extractWebpackModulesFromCode,
  writeWebpackModules,
} = require("./webpack_extract");
const { detectVM } = require("./vm/vm_detector");
const { analyzeVM } = require("./vm/vm_analyzer");
const { classifyAllHandlers, classifySummary } = require("./vm/opcode_classifier");

// 插件注册表
const PLUGINS = {
  strarr: require("./plugins/string_array_decoder"),
  string: require("./plugins/string_decoder"),
  hex: require("./plugins/hex_number"),
  obj: require("./plugins/object_inline"),
  prop: require("./plugins/const_propagation"),
  iife: require("./plugins/iife_inline"),
  constant: require("./plugins/constant_folding"),
  builtin: require("./plugins/builtin_static_eval"),
  control: require("./plugins/control_flow"),
  comma: require("./plugins/comma_expression"),
  anti: require("./plugins/anti_debug"),
  dead: require("./plugins/dead_code"),
  member: require("./plugins/member_expression"),
  rename: require("./plugins/rename_vars"),
  callapply: require("./plugins/call_apply_inline"),
  strconcat: require("./plugins/string_concat"),
};

// 默认执行顺序 (有依赖关系, 不能随意调整)
// strarr(动态解密) → string(转义还原) → hex(十六进制数字) → constant(常量折叠)
// → control(控制流) → comma(逗号拆分) → dead(死代码) → member(属性简化) → rename(重命名)
// 增强: obj(对象字典/包装器内联) 放在 constant 前, builtin(安全内置求值) 放在 constant 后,
// anti(反调试清理) 放在 dead 前, 便于后续死代码清理进一步删除无用分支
const DEFAULT_ORDER = [
  "strarr",
  "string",
  "strconcat",
  "hex",
  "obj",
  "prop",
  "iife",
  "callapply",
  "constant",
  "builtin",
  "control",
  "comma",
  "strconcat",
  "anti",
  "dead",
  "member",
  "rename",
];

function deobfuscate(code, pluginNames, passes) {
  console.log(chalk.cyan("\n[*] Parsing AST..."));
  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [
      "dynamicImport",
      "importMeta",
      "numericSeparator",
      "bigInt",
      "logicalAssignment",
      "optionalChaining",
      "nullishCoalescingOperator",
      "objectRestSpread",
      "classProperties",
      "classPrivateProperties",
      "classPrivateMethods",
      "privateIn",
      "topLevelAwait",
    ],
  });

  const originalLines = code.split("\n").length;
  console.log(chalk.gray(`    Source: ${code.length} chars, ${originalLines} lines`));

  const maxPasses = Math.max(1, Number.parseInt(passes, 10) || 1);
  for (let pass = 1; pass <= maxPasses; pass++) {
    if (maxPasses > 1) {
      console.log(chalk.gray(`\n[*] Pass ${pass}/${maxPasses}`));
    }

    let passTransforms = 0;

    // 按顺序执行每个插件
    for (const name of pluginNames) {
      const pluginFn = PLUGINS[name];
      if (!pluginFn) {
        console.log(chalk.yellow(`[!] Unknown plugin: ${name}, skipping`));
        continue;
      }

      console.log(chalk.cyan(`[*] Running: ${name}`));
      const counter = { count: 0 };
      try {
        const plugin = pluginFn({ counter });
        const visitor = plugin && plugin.visitor ? plugin.visitor : {};
        traverse(ast, visitor);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.log(chalk.yellow(`    ⚠ Plugin ${name} error (skipped): ${msg}`));
      }
      const transformCount = Number.isFinite(counter.count) ? counter.count : 0;
      passTransforms += transformCount;
      if (transformCount > 0) {
        console.log(chalk.green(`    ✓ ${transformCount} transforms`));
      } else {
        console.log(chalk.gray(`    - no changes`));
      }
    }

    if (passTransforms === 0) break;
  }

  // 生成还原后的代码
  console.log(chalk.cyan("[*] Generating output..."));
  const output = generator(ast, {
    comments: true,
    jsescOption: { minimal: true },
  });

  const outputLines = output.code.split("\n").length;
  console.log(chalk.green(`\n[✓] Deobfuscation complete`));
  console.log(chalk.gray(`    Output: ${output.code.length} chars, ${outputLines} lines`));

  return output.code;
}

// CLI
program
  .name("ast-deobfuscator")
  .description("JavaScript AST deobfuscation tool — 17 plugins, webpack extraction, VM analysis")
  .requiredOption("-i, --input <path>", "Input obfuscated JS file or directory")
  .option(
    "--scene <name>",
    "Scene preset: source|bundle|reverse",
    "reverse"
  )
  .option("--passes <n>", "Number of passes (default: 1)", "1")
  .option(
    "-o, --output <path>",
    "Output file or directory (default: input.deob.js / input_dir_deob)"
  )
  .option(
    "-p, --plugins <list>",
    `Plugins (comma-separated, available: ${Object.keys(PLUGINS).join(",")})`,
    DEFAULT_ORDER.join(",")
  )
  .option(
    "--ext <list>",
    "File extensions to process in directory mode (comma-separated)",
    ".js,.mjs,.cjs"
  )
  .option(
    "--ignore <list>",
    "Path segments to ignore in directory mode (comma-separated)",
    "node_modules,dist,build,out,.git"
  )
  .option("--webpack-extract", "Extract webpack modules from bundle", false)
  .option("--webpack-modules-out <dir>", "Output directory for extracted webpack modules")
  .option("--webpack-aggregate", "Aggregate webpack modules from multiple chunks into one directory", false)
  .option("--vm-analyze", "Detect and analyze VM-based obfuscation, output report", false)
  .parse(process.argv);

const rawArgv = process.argv.slice(2);
function hasArg(flag) {
  return rawArgv.includes(flag) || rawArgv.some((a) => a.startsWith(`${flag}=`));
}
function hasAnyArg(flags) {
  return flags.some((f) => hasArg(f));
}

const opts = program.opts();
const SCENE_PRESETS = {
  source: {
    plugins: DEFAULT_ORDER.join(","),
    ext: ".js,.mjs,.cjs",
    ignore: "node_modules,dist,build,out,.git,coverage",
  },
  bundle: {
    plugins: "string,hex,obj,prop,iife,constant,builtin,comma,anti,dead,member",
    ext: ".js,.mjs,.cjs",
    ignore: "node_modules,.git",
  },
  reverse: {
    plugins: DEFAULT_ORDER.join(","),
    ext: ".js,.mjs,.cjs",
    ignore: "node_modules,dist,build,out,.git",
  },
};

const sceneKey = String(opts.scene || "reverse").trim().toLowerCase();
const preset = SCENE_PRESETS[sceneKey] || SCENE_PRESETS.reverse;
if (!hasAnyArg(["-p", "--plugins"])) opts.plugins = preset.plugins;
if (!hasAnyArg(["--ext"])) opts.ext = preset.ext;
if (!hasAnyArg(["--ignore"])) opts.ignore = preset.ignore;

const pluginNames = String(opts.plugins)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toDeobFileName(filePath) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return `${base}.deob${ext || ".js"}`;
}

function shouldIgnorePath(p, ignoreParts) {
  const norm = p.replace(/\\/g, "/");
  return ignoreParts.some((part) => {
    const token = String(part || "").trim();
    if (!token) return false;
    return norm.includes(token);
  });
}

function collectFiles(rootDir, exts, ignoreParts) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    if (shouldIgnorePath(cur, ignoreParts)) continue;

    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const abs = path.join(cur, ent.name);
      if (shouldIgnorePath(abs, ignoreParts)) continue;
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (exts.includes(ext)) out.push(abs);
      }
    }
  }
  return out;
}

const inputPath = path.resolve(opts.input);
if (!fs.existsSync(inputPath)) {
  console.error(chalk.red(`[✗] Path not found: ${inputPath}`));
  process.exit(1);
}

const inputIsDir = isDirectory(inputPath);
const outputPath = opts.output ? path.resolve(opts.output) : null;
const exts = String(opts.ext || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ignoreParts = String(opts.ignore || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const resolvedOutput = (() => {
  if (outputPath) return outputPath;
  if (!inputIsDir) return inputPath.replace(/\.js$/, ".deob.js");
  const parent = path.dirname(inputPath);
  const name = path.basename(inputPath);
  return path.join(parent, `${name}_deob`);
})();

const webpackModulesRoot = (() => {
  if (opts.webpackModulesOut) return path.resolve(opts.webpackModulesOut);
  const base = inputIsDir ? resolvedOutput : path.dirname(resolvedOutput);
  return path.join(base, "webpack_modules");
})();

function webpackAggregateDirName() {
  if (!inputIsDir) return "_aggregate";
  const base = path.basename(inputPath);
  return `${base}_aggregate`;
}

console.log(chalk.bold("═══════════════════════════════════════"));
console.log(chalk.bold("  ast-deobfuscator v1.0"));
console.log(chalk.bold("═══════════════════════════════════════"));
console.log(chalk.gray(`  Input:   ${inputPath}`));
console.log(chalk.gray(`  Output:  ${resolvedOutput}`));
console.log(chalk.gray(`  Plugins: ${pluginNames.join(" → ")}`));

function vmAnalyze(code, reportPath) {
  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [
      "dynamicImport", "importMeta", "numericSeparator", "bigInt",
      "logicalAssignment", "optionalChaining", "nullishCoalescingOperator",
      "objectRestSpread", "classProperties", "classPrivateProperties",
      "classPrivateMethods", "privateIn", "topLevelAwait",
    ],
  });

  const detection = detectVM(ast);
  if (!detection.found) {
    console.log(chalk.gray("  [VM] 未检测到 VM 混淆模式"));
    return null;
  }

  console.log(chalk.cyan(`  [VM] 检测到 ${detection.count} 个 VM 模式`));

  const reports = [];
  for (const pattern of detection.patterns) {
    const analysis = analyzeVM(ast, pattern);
    if (!analysis) continue;

    const classified = classifyAllHandlers(analysis.opcodeHandlers);
    const summary = classifySummary(classified);

    const report = {
      type: pattern.type,
      confidence: pattern.confidence,
      codeVar: analysis.codeVar,
      pcVar: analysis.pcVar,
      stackVar: analysis.stackVar,
      regsVar: analysis.regsVar,
      caseCount: analysis.caseCount || (analysis.opcodeHandlers ? analysis.opcodeHandlers.length : 0),
      bytecodeLength: analysis.bytecodeInfo ? analysis.bytecodeInfo.length : null,
      opcodeClassification: classified,
      summary,
    };
    reports.push(report);

    // 打印人类可读摘要
    console.log(chalk.cyan(`\n  [VM] ${pattern.type} (置信度 ${pattern.confidence})`));
    console.log(chalk.gray(`    stack: ${analysis.stackVar || '?'}  |  regs: ${analysis.regsVar || '?'}  |  pc: ${analysis.pcVar || '?'}`));
    if (analysis.bytecodeInfo) {
      console.log(chalk.gray(`    bytecode: ${analysis.bytecodeInfo.length} 条指令`));
    }
    console.log(chalk.gray(`    opcodes: ${summary.total} 个 handler, ${summary.uniqueLabels} 种分类`));
    console.log(chalk.gray(`    分类统计:`));
    for (const [label, count] of Object.entries(summary.labelCounts)) {
      const opcodes = summary.opcodesByLabel[label];
      console.log(chalk.gray(`      ${label.padEnd(14)} ${String(count).padStart(3)} 个  (opcodes: ${opcodes.join(', ')})`));
    }
  }

  // 写入 JSON 报告
  if (reportPath && reports.length > 0) {
    const jsonReport = {
      file: inputPath,
      vmPatterns: reports.length,
      reports,
    };
    fs.writeFileSync(reportPath, JSON.stringify(jsonReport, null, 2), "utf-8");
    console.log(chalk.green(`\n  [VM] Report saved: ${reportPath}`));
  }

  return reports;
}

if (!inputIsDir) {
  const code = fs.readFileSync(inputPath, "utf-8");

  if (opts.vmAnalyze) {
    const reportPath = resolvedOutput.replace(/\.js$/, ".vm-report.json");
    vmAnalyze(code, reportPath);
  }

  if (opts.webpackExtract) {
    try {
      const extracted = extractWebpackModulesFromCode(code);
      if (extracted && extracted.modules && extracted.modules.length) {
        ensureDir(webpackModulesRoot);
        const outDir = opts.webpackAggregate
          ? path.join(webpackModulesRoot, webpackAggregateDirName())
          : path.join(webpackModulesRoot, path.basename(inputPath, path.extname(inputPath)));
        const n = writeWebpackModules(extracted, outDir);
        console.log(chalk.gray(`  Webpack modules exported: ${n} -> ${outDir}`));
      }
    } catch (e) {
      console.log(
        chalk.yellow(
          `[!] Webpack extraction failed: ${e && e.message ? e.message : String(e)}`
        )
      );
    }
  }

  const result = deobfuscate(code, pluginNames, opts.passes);
  fs.writeFileSync(resolvedOutput, result, "utf-8");
  console.log(chalk.green(`\n[✓] Saved to: ${resolvedOutput}\n`));
} else {
  if (fs.existsSync(resolvedOutput) && !isDirectory(resolvedOutput)) {
    console.error(chalk.red(`[✗] Output must be a directory when input is a directory: ${resolvedOutput}`));
    process.exit(1);
  }

  ensureDir(resolvedOutput);
  const files = collectFiles(inputPath, exts.length ? exts : [".js", ".mjs", ".cjs"], ignoreParts);
  if (!files.length) {
    console.log(chalk.yellow("[!] No files found to process"));
    process.exit(0);
  }

  console.log(chalk.gray(`  Batch: ${files.length} files`));
  let ok = 0;
  let fail = 0;

  for (const file of files) {
    const rel = path.relative(inputPath, file);
    const outDir = path.join(resolvedOutput, path.dirname(rel));
    const outFile = path.join(outDir, toDeobFileName(file));

    try {
      ensureDir(outDir);
      const code = fs.readFileSync(file, "utf-8");

      if (opts.webpackExtract) {
        try {
          const extracted = extractWebpackModulesFromCode(code);
          if (extracted && extracted.modules && extracted.modules.length) {
            const modOut = (() => {
              if (opts.webpackAggregate) {
                return path.join(webpackModulesRoot, webpackAggregateDirName());
              }
              const ext = path.extname(file);
              const base = path.basename(file, ext);
              return path.join(webpackModulesRoot, path.dirname(rel), base);
            })();
            const n = writeWebpackModules(extracted, modOut);
            if (n > 0) {
              console.log(chalk.gray(`  Webpack modules exported: ${n} -> ${modOut}`));
            }
          }
        } catch (e) {}
      }

      const result = deobfuscate(code, pluginNames, opts.passes);
      fs.writeFileSync(outFile, result, "utf-8");
      ok++;
      console.log(chalk.green(`[✓] ${rel} -> ${path.relative(process.cwd(), outFile)}`));
    } catch (e) {
      fail++;
      console.log(chalk.red(`[✗] ${rel} failed: ${e && e.message ? e.message : String(e)}`));
    }
  }

  console.log(chalk.green(`\n[✓] Batch complete: ${ok} succeeded, ${fail} failed`));
  console.log(chalk.green(`    Output: ${resolvedOutput}\n`));
}
