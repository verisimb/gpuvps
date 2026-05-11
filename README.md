# HASH256 GPU Miner (CUDA)

GPU miner untuk HASH256 menggunakan NVIDIA CUDA. Jauh lebih cepat dari CPU miner.

## Kebutuhan

- NVIDIA GPU (RTX series recommended)
- CUDA Toolkit (nvcc) - minimal CUDA 11.0
- Node.js 18+
- npm
- ETH untuk gas

## Install CUDA Toolkit

### Ubuntu/Debian (VPS)

```bash
# Install CUDA toolkit
sudo apt update
sudo apt install -y nvidia-cuda-toolkit

# Verify
nvcc --version
nvidia-smi
```

### Windows (Laptop RTX)

Download CUDA Toolkit dari: https://developer.nvidia.com/cuda-downloads

## Setup

```bash
cd hash256-gpu

# Install Node.js dependencies
npm install

# Copy dan edit .env
cp .env.example .env
nano .env
```

Isi `.env`:

```env
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0xYOUR_PRIVATE_KEY
GPU_BLOCKS=256
GPU_THREADS=256
```

## Build CUDA Miner

```bash
npm run build
```

Atau manual:

```bash
nvcc -O3 -o keccak_miner cuda/keccak_miner.cu
```

## Jalankan

```bash
npm start
```

## Cek State Kontrak

```bash
npm run check
```

## Tuning GPU

Sesuaikan `GPU_BLOCKS` dan `GPU_THREADS` di `.env`:

| GPU | Recommended Grid | Threads/batch |
|-----|-----------------|---------------|
| RTX 3060 | 256 x 256 | 65,536 |
| RTX 3080 | 512 x 256 | 131,072 |
| RTX 4070 | 512 x 256 | 131,072 |
| RTX 4090 | 1024 x 256 | 262,144 |

Lebih besar = lebih cepat, tapi jangan melebihi kapasitas GPU.
Cek dengan `nvidia-smi` untuk monitor usage.

## Perbandingan Speed

| Method | Hash Rate |
|--------|-----------|
| CPU (Node.js) | ~100K H/s |
| GPU RTX 3060 | ~50-100M H/s |
| GPU RTX 4090 | ~200-500M H/s |

## Troubleshooting

### `nvcc: command not found`

CUDA toolkit belum terinstall. Install dulu sesuai instruksi di atas.

### `CUDA error: no CUDA-capable device`

Driver NVIDIA belum terinstall atau GPU tidak terdeteksi.

```bash
nvidia-smi  # Cek apakah GPU terdeteksi
```

### `GPU miner error: ...`

Coba kurangi grid/block size di `.env`. Beberapa GPU tidak support ukuran besar.

### `insufficient funds`

Wallet perlu ETH untuk gas fee saat submit transaksi.
