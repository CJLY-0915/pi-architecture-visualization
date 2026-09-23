'use strict';

const { validateModel } = require('../core/validation');

const MAX_MODEL_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_CHARS = 2 * 1024 * 1024;
const HOST_ERROR_CODES = ['PERMISSION_DENIED', 'NOT_FOUND', 'READ_FAILED', 'INVALID_ARGUMENT'];

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (/[:\\\u0000-\u001f\u007f-\u009f]/.test(value) || value.startsWith('/')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

async function readModel(host, path, options = {}) {
  if (!isSafeRelativePath(path)) return failure('INVALID_PATH', 'Use a workspace-relative model file path without traversal.');
  let info;
  try {
    info = await host.fs.stat(path);
  } catch (error) {
    const code = error && HOST_ERROR_CODES.includes(error.code) ? error.code : 'READ_FAILED';
    return failure(code, 'The host could not inspect the model file.');
  }
  if (!info || !Number.isSafeInteger(info.size) || info.size < 0) return failure('READ_FAILED', 'The host did not return a valid model file size.');
  if (info.size > MAX_MODEL_BYTES) return failure('MODEL_TOO_LARGE', 'Expected model text of at most 2 MiB before decoding.');
  let text;
  try {
    text = await host.fs.readText(path);
  } catch (error) {
    const code = error && HOST_ERROR_CODES.includes(error.code) ? error.code : 'READ_FAILED';
    return failure(code, 'The host could not read the model file.');
  }
  if (typeof text !== 'string') return failure('READ_FAILED', 'The host did not return model text.');
  if (text.length > MAX_MODEL_CHARS) return failure('MODEL_TOO_LARGE', 'Expected model text of at most 2 Mi characters.');
  let model;
  try {
    model = JSON.parse(text);
  } catch {
    return failure('INVALID_JSON', 'The model file is not valid JSON.');
  }
  const validation = validateModel(model);
  if (!validation.valid) {
    if (options && options.allowInvalidModel === true) return { ok: true, model, validation };
    return { ok: false, validation, error: { code: 'INVALID_MODEL', message: 'The model failed structural validation; analysis was not performed.' } };
  }
  return { ok: true, model, validation };
}

module.exports = { readModel, isSafeRelativePath, MAX_MODEL_BYTES, MAX_MODEL_CHARS };
