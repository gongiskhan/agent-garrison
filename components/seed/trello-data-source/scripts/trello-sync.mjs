const boardId = process.env.TRELLO_BOARD_ID ?? "";
const truthFile = process.env.GARRISON_TRELLO_TASKS_FILE ?? "tasks/trello.md";

console.log(JSON.stringify({ component: "trello-data-source", boardIdConfigured: Boolean(boardId), truthFile }));
