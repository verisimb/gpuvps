#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <cuda_runtime.h>
#include <chrono>

// Keccak-256 round constants
__device__ __constant__ uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL,
    0x800000000000808aULL, 0x8000000080008000ULL,
    0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008aULL, 0x0000000000000088ULL,
    0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL,
    0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL,
    0x0000000080000001ULL, 0x8000000080008008ULL
};

__device__ __forceinline__ uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

__device__ void keccak_f1600(uint64_t state[25]) {
    uint64_t C[5], D[5], B[25];

    for (int round = 0; round < 24; round++) {
        // Theta
        C[0] = state[0] ^ state[5] ^ state[10] ^ state[15] ^ state[20];
        C[1] = state[1] ^ state[6] ^ state[11] ^ state[16] ^ state[21];
        C[2] = state[2] ^ state[7] ^ state[12] ^ state[17] ^ state[22];
        C[3] = state[3] ^ state[8] ^ state[13] ^ state[18] ^ state[23];
        C[4] = state[4] ^ state[9] ^ state[14] ^ state[19] ^ state[24];

        D[0] = C[4] ^ rotl64(C[1], 1);
        D[1] = C[0] ^ rotl64(C[2], 1);
        D[2] = C[1] ^ rotl64(C[3], 1);
        D[3] = C[2] ^ rotl64(C[4], 1);
        D[4] = C[3] ^ rotl64(C[0], 1);

        state[0]  ^= D[0]; state[5]  ^= D[0]; state[10] ^= D[0]; state[15] ^= D[0]; state[20] ^= D[0];
        state[1]  ^= D[1]; state[6]  ^= D[1]; state[11] ^= D[1]; state[16] ^= D[1]; state[21] ^= D[1];
        state[2]  ^= D[2]; state[7]  ^= D[2]; state[12] ^= D[2]; state[17] ^= D[2]; state[22] ^= D[2];
        state[3]  ^= D[3]; state[8]  ^= D[3]; state[13] ^= D[3]; state[18] ^= D[3]; state[23] ^= D[3];
        state[4]  ^= D[4]; state[9]  ^= D[4]; state[14] ^= D[4]; state[19] ^= D[4]; state[24] ^= D[4];

        // Rho + Pi
        B[0]  = state[0];
        B[1]  = rotl64(state[6], 44);
        B[2]  = rotl64(state[12], 43);
        B[3]  = rotl64(state[18], 21);
        B[4]  = rotl64(state[24], 14);
        B[5]  = rotl64(state[3], 28);
        B[6]  = rotl64(state[9], 20);
        B[7]  = rotl64(state[10], 3);
        B[8]  = rotl64(state[16], 45);
        B[9]  = rotl64(state[22], 61);
        B[10] = rotl64(state[1], 1);
        B[11] = rotl64(state[7], 6);
        B[12] = rotl64(state[13], 25);
        B[13] = rotl64(state[19], 8);
        B[14] = rotl64(state[20], 18);
        B[15] = rotl64(state[4], 27);
        B[16] = rotl64(state[5], 36);
        B[17] = rotl64(state[11], 10);
        B[18] = rotl64(state[17], 15);
        B[19] = rotl64(state[23], 56);
        B[20] = rotl64(state[2], 62);
        B[21] = rotl64(state[8], 55);
        B[22] = rotl64(state[14], 39);
        B[23] = rotl64(state[15], 41);
        B[24] = rotl64(state[21], 2);

        // Chi
        state[0]  = B[0]  ^ ((~B[1])  & B[2]);
        state[1]  = B[1]  ^ ((~B[2])  & B[3]);
        state[2]  = B[2]  ^ ((~B[3])  & B[4]);
        state[3]  = B[3]  ^ ((~B[4])  & B[0]);
        state[4]  = B[4]  ^ ((~B[0])  & B[1]);
        state[5]  = B[5]  ^ ((~B[6])  & B[7]);
        state[6]  = B[6]  ^ ((~B[7])  & B[8]);
        state[7]  = B[7]  ^ ((~B[8])  & B[9]);
        state[8]  = B[8]  ^ ((~B[9])  & B[5]);
        state[9]  = B[9]  ^ ((~B[5])  & B[6]);
        state[10] = B[10] ^ ((~B[11]) & B[12]);
        state[11] = B[11] ^ ((~B[12]) & B[13]);
        state[12] = B[12] ^ ((~B[13]) & B[14]);
        state[13] = B[13] ^ ((~B[14]) & B[10]);
        state[14] = B[14] ^ ((~B[10]) & B[11]);
        state[15] = B[15] ^ ((~B[16]) & B[17]);
        state[16] = B[16] ^ ((~B[17]) & B[18]);
        state[17] = B[17] ^ ((~B[18]) & B[19]);
        state[18] = B[18] ^ ((~B[19]) & B[15]);
        state[19] = B[19] ^ ((~B[15]) & B[16]);
        state[20] = B[20] ^ ((~B[21]) & B[22]);
        state[21] = B[21] ^ ((~B[22]) & B[23]);
        state[22] = B[22] ^ ((~B[23]) & B[24]);
        state[23] = B[23] ^ ((~B[24]) & B[20]);
        state[24] = B[24] ^ ((~B[20]) & B[21]);

        // Iota
        state[0] ^= RC[round];
    }
}

// Compute keccak256 of exactly 64 bytes (challenge 32 bytes + nonce 32 bytes)
__device__ void keccak256_64bytes(const uint8_t *input, uint8_t *output) {
    uint64_t state[25];
    memset(state, 0, sizeof(state));

    // Absorb 64 bytes (8 uint64_t lanes) - rate is 136 bytes for keccak256
    for (int i = 0; i < 8; i++) {
        uint64_t lane = 0;
        for (int j = 0; j < 8; j++) {
            lane |= ((uint64_t)input[i * 8 + j]) << (j * 8);
        }
        state[i] ^= lane;
    }

    // Padding: 0x01 at byte 64, 0x80 at byte 135 (rate - 1)
    state[8] ^= 0x01;
    state[16] ^= 0x8000000000000000ULL;

    keccak_f1600(state);

    // Squeeze 32 bytes
    for (int i = 0; i < 4; i++) {
        for (int j = 0; j < 8; j++) {
            output[i * 8 + j] = (uint8_t)(state[i] >> (j * 8));
        }
    }
}

// Compare hash (as big-endian uint256) < difficulty (as big-endian uint256)
__device__ bool hash_less_than(const uint8_t *hash, const uint8_t *difficulty) {
    for (int i = 0; i < 32; i++) {
        if (hash[i] < difficulty[i]) return true;
        if (hash[i] > difficulty[i]) return false;
    }
    return false;
}

__global__ void mine_kernel(
    const uint8_t *challenge,
    const uint8_t *difficulty,
    uint64_t start_nonce,
    uint64_t *result_nonce,
    int *found
) {
    uint64_t tid = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    uint64_t nonce = start_nonce + tid;

    if (*found) return;

    // Build input: challenge (32 bytes) + nonce as uint256 big-endian (32 bytes)
    uint8_t input[64];

    // Copy challenge (already big-endian)
    for (int i = 0; i < 32; i++) {
        input[i] = challenge[i];
    }

    // Nonce as uint256 big-endian (pad with zeros on the left)
    memset(input + 32, 0, 24);
    input[56] = (uint8_t)(nonce >> 56);
    input[57] = (uint8_t)(nonce >> 48);
    input[58] = (uint8_t)(nonce >> 40);
    input[59] = (uint8_t)(nonce >> 32);
    input[60] = (uint8_t)(nonce >> 24);
    input[61] = (uint8_t)(nonce >> 16);
    input[62] = (uint8_t)(nonce >> 8);
    input[63] = (uint8_t)(nonce);

    uint8_t hash[32];
    keccak256_64bytes(input, hash);

    if (hash_less_than(hash, difficulty)) {
        int old = atomicCAS(found, 0, 1);
        if (old == 0) {
            *result_nonce = nonce;
        }
    }
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <challenge_hex> <difficulty_hex> [start_nonce] [grid_size] [block_size] [device_id]\n", argv[0]);
        return 1;
    }

    // Parse challenge (64 hex chars = 32 bytes)
    const char *challenge_hex = argv[1];
    uint8_t challenge[32];
    for (int i = 0; i < 32; i++) {
        unsigned int byte;
        sscanf(challenge_hex + i * 2, "%02x", &byte);
        challenge[i] = (uint8_t)byte;
    }

    // Parse difficulty (variable length hex, pad to 64 chars big-endian)
    const char *difficulty_hex = argv[2];
    uint8_t difficulty[32];
    char diff_padded[65];
    int diff_len = strlen(difficulty_hex);
    memset(diff_padded, '0', 64);
    diff_padded[64] = '\0';
    if (diff_len <= 64) {
        memcpy(diff_padded + (64 - diff_len), difficulty_hex, diff_len);
    } else {
        memcpy(diff_padded, difficulty_hex + (diff_len - 64), 64);
    }
    for (int i = 0; i < 32; i++) {
        unsigned int byte;
        sscanf(diff_padded + i * 2, "%02x", &byte);
        difficulty[i] = (uint8_t)byte;
    }

    uint64_t start_nonce = 0;
    int grid_size = 512;
    int block_size = 256;
    int device_id = 0;

    if (argc > 3) start_nonce = strtoull(argv[3], NULL, 10);
    if (argc > 4) grid_size = atoi(argv[4]);
    if (argc > 5) block_size = atoi(argv[5]);
    if (argc > 6) device_id = atoi(argv[6]);

    // Set GPU device
    cudaError_t devErr = cudaSetDevice(device_id);
    if (devErr != cudaSuccess) {
        fprintf(stderr, "Failed to set CUDA device %d: %s\n", device_id, cudaGetErrorString(devErr));
        return 1;
    }

    cudaDeviceProp prop;
    cudaGetDeviceProperties(&prop, device_id);
    fprintf(stderr, "[GPU %d] %s | SMs: %d | Clock: %d MHz\n",
            device_id, prop.name, prop.multiProcessorCount, prop.clockRate / 1000);

    uint64_t threads_per_batch = (uint64_t)grid_size * block_size;

    // Allocate device memory
    uint8_t *d_challenge, *d_difficulty;
    uint64_t *d_result_nonce;
    int *d_found;

    cudaMalloc(&d_challenge, 32);
    cudaMalloc(&d_difficulty, 32);
    cudaMalloc(&d_result_nonce, sizeof(uint64_t));
    cudaMalloc(&d_found, sizeof(int));

    cudaMemcpy(d_challenge, challenge, 32, cudaMemcpyHostToDevice);
    cudaMemcpy(d_difficulty, difficulty, 32, cudaMemcpyHostToDevice);

    int found = 0;
    uint64_t result_nonce = 0;
    uint64_t total_hashes = 0;

    cudaMemcpy(d_found, &found, sizeof(int), cudaMemcpyHostToDevice);

    fprintf(stderr, "[GPU %d] Mining | Grid: %d | Block: %d | Batch: %llu threads\n",
            device_id, grid_size, block_size, (unsigned long long)threads_per_batch);

    auto t_start = std::chrono::high_resolution_clock::now();
    auto t_report = t_start;

    while (!found) {
        mine_kernel<<<grid_size, block_size>>>(
            d_challenge, d_difficulty, start_nonce, d_result_nonce, d_found
        );

        cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            fprintf(stderr, "[GPU %d] Kernel Error: %s\n", device_id, cudaGetErrorString(err));
            return 1;
        }
        cudaDeviceSynchronize();

        cudaMemcpy(&found, d_found, sizeof(int), cudaMemcpyDeviceToHost);

        total_hashes += threads_per_batch;
        start_nonce += threads_per_batch;

        // Report every ~2 seconds
        auto t_now = std::chrono::high_resolution_clock::now();
        double elapsed_report = std::chrono::duration<double>(t_now - t_report).count();
        if (elapsed_report >= 2.0) {
            double total_elapsed = std::chrono::duration<double>(t_now - t_start).count();
            double mhs = (total_hashes / 1000000.0) / total_elapsed;
            fprintf(stderr, "[GPU %d] %llu M hashes | %.2f MH/s\n",
                    device_id, (unsigned long long)(total_hashes / 1000000), mhs);
            t_report = t_now;
        }
    }

    cudaMemcpy(&result_nonce, d_result_nonce, sizeof(uint64_t), cudaMemcpyDeviceToHost);

    auto t_end = std::chrono::high_resolution_clock::now();
    double total_time = std::chrono::duration<double>(t_end - t_start).count();
    double final_mhs = (total_hashes / 1000000.0) / total_time;

    // Output nonce to stdout (Node.js reads this)
    printf("%llu\n", (unsigned long long)result_nonce);
    fflush(stdout);

    fprintf(stderr, "[GPU %d] FOUND nonce: %llu | %llu M hashes | %.2f MH/s | %.2fs\n",
            device_id, (unsigned long long)result_nonce,
            (unsigned long long)(total_hashes / 1000000), final_mhs, total_time);

    cudaFree(d_challenge);
    cudaFree(d_difficulty);
    cudaFree(d_result_nonce);
    cudaFree(d_found);

    return 0;
}
