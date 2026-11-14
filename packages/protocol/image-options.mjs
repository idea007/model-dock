const MiB = 1024 * 1024;

export const imageAspectRatios = ['16:9', '9:16', '1:1', '4:5'];
export const maxImageReferences = 5;
export const maxImageResultBytes = 30 * MiB;
// A gateway result can be sent back as a reference without re-encoding it.
export const maxImageReferenceBytes = maxImageResultBytes;
export const maxImageReferenceTotalBytes = 50 * MiB;
export const maxImageRequestBytes = 70 * MiB;
