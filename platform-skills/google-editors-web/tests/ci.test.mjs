import './editor-data.test.mjs';
import './office-export.test.mjs';
import './workflow.test.mjs';
import { registerInstructionGuideContract } from '../../tools/instruction-guide-contract.mjs';
registerInstructionGuideContract(new URL('../', import.meta.url));
import './passive-sheet.test.mjs';
