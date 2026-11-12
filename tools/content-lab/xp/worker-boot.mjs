import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
import './repo-resolve.mjs';

register();
await import(workerData.entry);
