// 核算智慧树上报记录中的倍速加权
//
// 用法：
//   node analyze_records.js                # 用内置的实测样本
//   node analyze_records.js records.json   # 用自己抓到的记录
//
// 抓取方法见 README 或 实测结论.md 里的控制台脚本，把 __rec 数组复制成 JSON 保存。
//
// 判据：同一条记录里比较 studyTotalTime 与 (endDate - startDate) / 1000
//   - 两者相等      → 倍速因子未乘入（平台按真实时间记账）
//   - 前者约为后者 N 倍 → 倍速因子已乘入

const fs = require('fs');

// 内置样本：实测 2 倍速播放，总长 693 秒
const SAMPLE = [
  { studyTotalTime: '30', startWatchTime: '571', endWatchTime: '631',
    startDate: '1793387208574', endDate: '1793387238616' },
  { studyTotalTime: '30', startWatchTime: '631', endWatchTime: '691',
    startDate: '1793387238616', endDate: '1793387268662' },
  { studyTotalTime: '1', startWatchTime: '691', endWatchTime: '694',
    startDate: '1793387268662', endDate: '1793387270130' },
];

const file = process.argv[2];
let recs = SAMPLE;
if (file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 兼容两种格式：纯记录数组，或 __rec 混入 {t, body} 的形式
  recs = raw.filter(r => r && r.studyTotalTime !== undefined);
  if (!recs.length) { console.error('未在文件中找到含 studyTotalTime 的记录'); process.exit(1); }
}

const totalArg = process.argv[3] ? Number(process.argv[3]) : 693;

console.log('序号 |  墙钟时长 | 位置推进 | 实测倍速 | 上报值 | 若加权应记');
console.log('-'.repeat(64));

let sumWall = 0, sumReport = 0;
for (let i = 0; i < recs.length; i++) {
  const r = recs[i];
  const wall = (Number(r.endDate) - Number(r.startDate)) / 1000;
  const pos = Number(r.endWatchTime) - Number(r.startWatchTime);
  const rate = wall > 0 ? pos / wall : 0;
  const shouldBe = wall * rate;
  sumWall += wall;
  sumReport += Number(r.studyTotalTime);
  console.log(
    ` ${String(i).padStart(3)} | ${wall.toFixed(2).padStart(7)}s | ` +
    `${String(pos).padStart(6)}s | ${rate.toFixed(2).padStart(7)}x | ` +
    `${String(r.studyTotalTime).padStart(5)}s | ${String(Math.round(shouldBe)).padStart(6)}s`
  );
}

console.log('-'.repeat(64));
const ratio = sumWall > 0 ? sumReport / sumWall : 0;
console.log(`合计：墙钟 ${sumWall.toFixed(1)}s，上报 ${sumReport}s，比值 ${ratio.toFixed(3)}`);

const avgRate = recs.length
  ? recs.reduce((sum, r) => {
      const wall = (Number(r.endDate) - Number(r.startDate)) / 1000;   // 毫秒 → 秒
      return sum + (wall > 0 ? (Number(r.endWatchTime) - Number(r.startWatchTime)) / wall : 0);
    }, 0) / recs.length
  : 0;

console.log('');
if (Math.abs(ratio - 1) < 0.1) {
  console.log(`✗ 比值接近 1.0 → 倍速因子未乘入，平台按真实时间记账（实测倍速 ${avgRate.toFixed(2)}x 被忽略）`);
  if (totalArg > 0) {
    const pct = Math.min(100, (totalArg / avgRate) / totalArg * 100);
    console.log(`  按此记账，${avgRate.toFixed(2)}x 看完 ${totalArg}s 的视频，进度约 ${pct.toFixed(0)}%`);
  }
} else if (Math.abs(ratio - avgRate) < 0.15) {
  console.log(`✓ 比值接近实测倍速 ${avgRate.toFixed(2)} → 倍速因子已乘入，加权正常`);
} else {
  console.log(`? 比值 ${ratio.toFixed(3)} 与实测倍速 ${avgRate.toFixed(2)} 不匹配，需进一步分析`);
}
