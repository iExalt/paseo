import assert from "node:assert/strict";
      assert.deepEqual(opened, nacl.box.open.after(box, nonce, sharedKey));
      assert.deepEqual(opened, plaintext);
