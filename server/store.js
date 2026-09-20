'use strict';

/**
 * 极简 JSON 文件存储：整个数据集读入内存，写操作防抖落盘。
 * 数据结构：
 * {
 *   pipelines: [{ id, name, description, stages: [...], createdAt, updatedAt }],
 *   runs: [{ id, pipelineId, pipelineName, status, trigger, startedAt, finishedAt,
 *            durationSec, stages: [{id,name,type,status,startedAt,finishedAt,durationSec,reason}],
 *            waitingGate: { stageId, stageName, since } | null }]
 * }
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

let cache = null;
let saveTimer = null;

function emptyData() {
  return { pipelines: [], runs: [], meta: { seededAt: null } };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    cache = JSON.parse(raw);
    if (!Array.isArray(cache.pipelines) || !Array.isArray(cache.runs)) {
      throw new Error('数据文件结构不完整');
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      cache = emptyData();
      saveNow();
    } else {
      throw new Error(`无法读取数据文件 ${DATA_FILE}：${err.message}`);
    }
  }
  return cache;
}

function saveNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/** 防抖落盘，避免一次操作多次写。 */
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 50);
}

function replaceAll(data) {
  cache = {
    pipelines: data.pipelines || [],
    runs: data.runs || [],
    meta: data.meta || { seededAt: null },
  };
  saveNow();
}

module.exports = { load, save, saveNow, replaceAll, DATA_FILE };
