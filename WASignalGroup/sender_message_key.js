const { deriveSecrets } = require('@skidy89/libsignal-node/src/crypto');
class SenderMessageKey {
    iteration = 0;

    iv = Buffer.alloc(0);

    cipherKey = Buffer.alloc(0);

    seed = Buffer.alloc(0);

    constructor(iteration, seed) {
        
        const derivative = deriveSecrets(seed, Buffer.alloc(32), Buffer.from('WhisperGroup'));
         this.iv = Buffer.from(derivative[0].subarray(0, 16));
         this.cipherKey = Buffer.concat([derivative[0].subarray(16), derivative[1].subarray(0, 16)]);
         this.iteration = iteration;
         this.seed = seed;
    }

    getIteration() {
        return this.iteration;
    }

    getIv() {
        return this.iv;
    }

    getCipherKey() {
        return this.cipherKey;
    }

    getSeed() {
        return this.seed;
    }
}
module.exports = SenderMessageKey;