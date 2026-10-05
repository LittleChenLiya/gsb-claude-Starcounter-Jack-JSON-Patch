export * from './module/core.mjs';
export * from './module/duplex.mjs';
export * from './module/signedPatch.mjs';
export {
    PatchError as JsonPatchError,
    _deepClone as deepClone,
    escapePathComponent,
    unescapePathComponent
} from './module/helpers.mjs';


/**
 * Default export for backwards compat
 */

import * as core from './module/core.mjs';
import * as duplex from './module/duplex.mjs';
import * as signedPatch from './module/signedPatch.mjs';
import {
    PatchError as JsonPatchError,
    _deepClone as deepClone,
    escapePathComponent,
    unescapePathComponent
} from './module/helpers.mjs';

export default Object.assign({}, core, duplex, signedPatch, {
    JsonPatchError,
    deepClone,
    escapePathComponent,
    unescapePathComponent
});