ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.bindFunction('CGPreflightPostEventAccess', ['bool', []]);

if (!$.CGPreflightPostEventAccess()) throw new Error('automation_blocked');
var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
if (ObjC.unwrap(front.bundleIdentifier) !== 'com.todesktop.230313mzl4w4u92') {
  throw new Error('cursor_not_focused');
}

// The bridge owns these references until this one-shot script exits.
var down = $.CGEventCreateKeyboardEvent(null, 36, true);
var up = $.CGEventCreateKeyboardEvent(null, 36, false);
$.CGEventSetFlags(down, 0);
$.CGEventSetFlags(up, 0);
$.CGEventPost(0, down);
$.CGEventPost(0, up);
JSON.stringify({ enter_sent: true });
