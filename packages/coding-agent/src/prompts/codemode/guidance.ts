import editWrite from "./edit-write.md" with { type: "text" };
import execution from "./execution.md" with { type: "text" };
import interactive from "./interactive.md" with { type: "text" };
import remoteWeb from "./remote-web.md" with { type: "text" };
import searchRead from "./search-read.md" with { type: "text" };
import subagents from "./subagents.md" with { type: "text" };

export const guidance = [searchRead, editWrite, execution, subagents, remoteWeb, interactive].join("\n");
