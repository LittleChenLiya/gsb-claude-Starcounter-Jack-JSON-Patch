export * from './src/core';
export * from './src/duplex';
export * from './src/signedPatch';
export {
    PatchError as JsonPatchError,
    _deepClone as deepClone,
    escapePathComponent,
    unescapePathComponent
} from './src/helpers';


/**
 * Default export for backwards compat
 */

import * as core from './src/core';
import * as duplex from './src/duplex';
import * as signedPatch from './src/signedPatch';
import {
    PatchError as JsonPatchError,
    _deepClone as deepClone,
    escapePathComponent,
    unescapePathComponent
} from './src/helpers';

export default {
    ...core,
    ...duplex,
    ...signedPatch,
    JsonPatchError,
    deepClone,
    escapePathComponent,
    unescapePathComponent
}