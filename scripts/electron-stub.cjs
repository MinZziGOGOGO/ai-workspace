// Minimal electron stub for running main-process modules under plain node in tests.
// The indexer only touches BrowserWindow.getAllWindows(); return none.
module.exports = {
  BrowserWindow: { getAllWindows: () => [] }
}
