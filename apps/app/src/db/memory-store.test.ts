import { MemoryStore } from '../core/memory-store.js';
import { describeStoreContract } from './store-contract.js';

describeStoreContract('MemoryStore', () => new MemoryStore());
