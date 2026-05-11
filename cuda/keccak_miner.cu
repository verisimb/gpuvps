#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <cuda_runtime.h>
#include <chrono>

// Number of hashes each thread computes per kernel launch.
// Reduces kernel launch overhead proportionally.
#ifndef HASHES_PER_THREAD
#define HASHES_PER_THREAD 8
#endif

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

// Precomputed base state: challenge absorbed + padding applied.
// Lane 7 = 0 (will XOR with nonce per hash).
__device__ __constant__ uint64_t BASE_STATE[25];

__device__ __forceinline__ uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

__device__ __forceinline__ uint64_t bswap64(uint64_t x) {
    x = ((x >> 8) & 0x00FF00FF00FF00FFULL) | ((x & 0x00FF00FF00FF00FFULL) << 8);
    x = ((x >> 16) & 0x0000FFFF0000FFFFULL) | ((x & 0x0000FFFF0000FFFFULL) << 16);
    return (x >> 32) | (x << 32);
}

__device__ __forceinline__ void keccak_f1600(uint64_t state[25]) {
    uint64_t C[5], D[5], B[25];

    #pragma unroll 1
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

        // Rho + Pi (combined permutation mapping)
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

// Compare hash (big-endian uint256) < difficulty (big-endian uint256).
// Keccak output: byte 0 = LSB of lane 0, byte 7 = MSB of lane 0, byte 8 = LSB of lane 1, etc.
// When cast to uint256, byte 0 is the MOST significant byte.
// So we compare: lane0 LSB first (most significant), then lane0 next byte, etc.
// This is equivalent to comparing the raw output bytes from index 0 to 31.
__device__ __forceinline__ bool hash_less_than_diff(const uint64_t *state, const uint8_t *difficulty) {
    for (int i = 0; i < 4; i++) {
        uint64_t lane = state[i];
        for (int j = 0; j < 8; j++) {
            uint8_t hbyte = (uint8_t)(lane >> (j * 8));
            uint8_t dbyte = difficulty[i * 8 + j];
            if (hbyte < dbyte) return true;
            if (hbyte > dbyte) return false;
        }
    }
    return false;
}

__global__ void __launch_bounds__(256, 4) mine_kernel(
    const uint8_t *difficulty,   // 32 bytes big-endian
    uint64_t start_nonce,
    uint64_t *result_nonce,
    int *found
) {
    // Early exit if another thread already found
    if (*found) return;

    uint64_t tid = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    uint64_t base_nonce = start_nonce + tid * HASHES_PER_THREAD;

    // Precomputed base state (challenge absorbed + padding)
    uint64_t base[25];
    #pragma unroll
    for (int i = 0; i < 25; i++) base[i] = BASE_STATE[i];

    #pragma unroll
    for (int k = 0; k < HASHES_PER_THREAD; k++) {
        uint64_t nonce = base_nonce + k;

        // Build state: base + (nonce XOR into lane 7)
        // Input bytes 56..63 = nonce big-endian. In lane (little-endian uint64),
        // this means lane 7 = bswap64(nonce).
        uint64_t state[25];
        #pragma unroll
        for (int i = 0; i < 25; i++) state[i] = base[i];
        state[7] ^= bswap64(nonce);

        keccak_f1600(state);

        if (hash_less_than_diff(state, difficulty)) {
            int old = atomicCAS(found, 0, 1);
            if (old == 0) {
                *result_nonce = nonce;
            }
            return;
        }

        // Periodically check global found flag (reduces wasted work when another thread wins)
        if ((k & 3) == 3) {
            if (*found) return;
        }
    }
}

// ─── Host Code ────────────────────────────────────────────────────────────────

static void hex_to_bytes(const char *hex, uint8_t *out, int out_len) {
    char padded[129];
    int hex_len = strlen(hex);
    int need = out_len * 2;
    memset(padded, '0', need);
    padded[need] = '\0';
    if (hex_len <= need) {
        memcpy(padded + (need - hex_len), hex, hex_len);
    } else {
        memcpy(padded, hex + (hex_len - need), need);
    }
    for (int i = 0; i < out_len; i++) {
        unsigned int byte;
        sscanf(padded + i * 2, "%02x", &byte);
        out[i] = (uint8_t)byte;
    }
}

// Precompute base state on host: absorb challenge bytes + padding.
// Input layout: challenge[0..31] + zeros[32..55] + nonce_placeholder[56..63]
// Rate = 136 bytes = 17 lanes, we absorb 64 bytes (8 lanes), then pad.
static void compute_base_state(const uint8_t *challenge, uint64_t base_state[25]) {
    memset(base_state, 0, 25 * sizeof(uint64_t));

    // Absorb lanes 0..3 (challenge) as little-endian
    for (int i = 0; i < 4; i++) {
        uint64_t lane = 0;
        for (int j = 0; j < 8; j++) {
            lane |= ((uint64_t)challenge[i * 8 + j]) << (j * 8);
        }
        base_state[i] ^= lane;
    }
    // Lanes 4..6 are zero (input bytes 32..55 are zero), no XOR needed.
    // Lane 7 is placeholder (will XOR with nonce per thread).

    // Padding: 0x01 at byte 64, 0x80 at byte 135
    // byte 64 falls into lane 8, position 0 (low byte) => state[8] ^= 0x01
    // byte 135 falls into lane 16, position 7 (high byte) => state[16] ^= 0x80 << 56
    base_state[8] ^= 0x01ULL;
    base_state[16] ^= 0x8000000000000000ULL;
}

// Convert big-endian 32-byte difficulty - just pass as-is (bytes)
// No conversion needed since kernel compares byte-by-byte

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <challenge_hex> <difficulty_hex> [start_nonce] [grid_size] [block_size] [device_id]\n", argv[0]);
        return 1;
    }

    uint8_t challenge[32];
    hex_to_bytes(argv[1], challenge, 32);

    uint8_t difficulty[32];
    hex_to_bytes(argv[2], difficulty, 32);

    uint64_t start_nonce = 0;
    int grid_size = 24576;
    int block_size = 256;
    int device_id = 0;

    if (argc > 3) start_nonce = strtoull(argv[3], NULL, 10);
    if (argc > 4) grid_size = atoi(argv[4]);
    if (argc > 5) block_size = atoi(argv[5]);
    if (argc > 6) device_id = atoi(argv[6]);

    cudaError_t devErr = cudaSetDevice(device_id);
    if (devErr != cudaSuccess) {
        fprintf(stderr, "Failed to set CUDA device %d: %s\n", device_id, cudaGetErrorString(devErr));
        return 1;
    }

    cudaDeviceProp prop;
    cudaGetDeviceProperties(&prop, device_id);
    fprintf(stderr, "[GPU %d] %s | SMs: %d | HPT: %d\n",
            device_id, prop.name, prop.multiProcessorCount, HASHES_PER_THREAD);

    // Precompute base state
    uint64_t h_base_state[25];
    compute_base_state(challenge, h_base_state);

    // Copy to constant memory
    cudaMemcpyToSymbol(BASE_STATE, h_base_state, 25 * sizeof(uint64_t));

    // Allocate device buffers
    uint8_t *d_difficulty;
    uint64_t *d_result_nonce;
    int *d_found;

    cudaMalloc(&d_difficulty, 32);
    cudaMalloc(&d_result_nonce, sizeof(uint64_t));
    cudaMalloc(&d_found, sizeof(int));

    cudaMemcpy(d_difficulty, difficulty, 32, cudaMemcpyHostToDevice);

    int found = 0;
    uint64_t result_nonce = 0;
    uint64_t total_hashes = 0;
    const uint64_t threads_per_batch = (uint64_t)grid_size * block_size;
    const uint64_t hashes_per_batch = threads_per_batch * HASHES_PER_THREAD;

    cudaMemcpy(d_found, &found, sizeof(int), cudaMemcpyHostToDevice);

    fprintf(stderr, "[GPU %d] Mining | Grid: %d | Block: %d | Batch: %llu hashes (HPT=%d)\n",
            device_id, grid_size, block_size,
            (unsigned long long)hashes_per_batch, HASHES_PER_THREAD);

    auto t_start = std::chrono::high_resolution_clock::now();
    auto t_report = t_start;

    while (!found) {
        mine_kernel<<<grid_size, block_size>>>(
            d_difficulty, start_nonce, d_result_nonce, d_found
        );

        cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            fprintf(stderr, "[GPU %d] Kernel Error: %s\n", device_id, cudaGetErrorString(err));
            return 1;
        }
        cudaDeviceSynchronize();

        cudaMemcpy(&found, d_found, sizeof(int), cudaMemcpyDeviceToHost);

        total_hashes += hashes_per_batch;
        start_nonce += hashes_per_batch;

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

    printf("%llu\n", (unsigned long long)result_nonce);
    fflush(stdout);

    fprintf(stderr, "[GPU %d] FOUND: %llu | %llu M hashes | %.2f MH/s | %.2fs\n",
            device_id, (unsigned long long)result_nonce,
            (unsigned long long)(total_hashes / 1000000), final_mhs, total_time);

    cudaFree(d_difficulty);
    cudaFree(d_result_nonce);
    cudaFree(d_found);

    return 0;
}
