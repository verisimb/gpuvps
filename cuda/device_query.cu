#include <stdio.h>
#include <cuda_runtime.h>

int main() {
    int deviceCount = 0;
    cudaGetDeviceCount(&deviceCount);

    if (deviceCount == 0) {
        printf("0\n");
        return 1;
    }

    // Output format: num_devices
    // Then per device: id,name,sm_count,max_threads_per_block,clock_mhz
    printf("%d\n", deviceCount);

    for (int i = 0; i < deviceCount; i++) {
        cudaDeviceProp prop;
        cudaGetDeviceProperties(&prop, i);
        printf("%d,%s,%d,%d,%d\n",
            i,
            prop.name,
            prop.multiProcessorCount,
            prop.maxThreadsPerBlock,
            prop.clockRate / 1000);
    }

    return 0;
}
