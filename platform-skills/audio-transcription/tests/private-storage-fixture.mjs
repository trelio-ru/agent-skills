import {privateDirectory} from '../scripts/storage.mjs';
privateDirectory(process.argv[2]);
process.stdout.write('PRIVATE_STORAGE_OK\n');
