/**
 * Process management utilities.
 */

import { setNativeKillTree } from "@nghyane/pi-utils";
import { native } from "../native";

setNativeKillTree(native.killTree);

export const { killTree, listDescendants } = native;
