/**
 * Process management utilities.
 */

import { setNativeKillTree } from "@nghyane/arcane-utils";
import { native } from "../native";

setNativeKillTree(native.killTree);

export const { killTree, listDescendants } = native;
