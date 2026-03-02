// Memory write queue — serializes all memory file writes so concurrent sessions
// never corrupt shared memory files. Each write uses atomic temp+rename.

const queue = [];
let processing = false;

/**
 * Enqueue a write operation. The operation function is called when it's this
 * entry's turn. Returns a Promise that resolves with the operation's return value.
 *
 * @param {() => any} operation - Synchronous or async function that performs the write
 * @returns {Promise<any>}
 */
function enqueueWrite(operation) {
  return new Promise((resolve, reject) => {
    queue.push({ operation, resolve, reject });
    if (!processing) processNext();
  });
}

async function processNext() {
  if (queue.length === 0) {
    processing = false;
    return;
  }
  processing = true;
  const { operation, resolve, reject } = queue.shift();
  try {
    const result = await operation();
    resolve(result);
  } catch (err) {
    reject(err);
  }
  // Process next item regardless of success/failure
  processNext();
}

module.exports = { enqueueWrite };
