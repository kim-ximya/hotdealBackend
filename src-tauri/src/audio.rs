const WAV: &[u8] = include_bytes!("../../desktop/assets/notification.wav");
const WAV_HEADER_BYTES: usize = 44;

fn scaled_chime(volume: u8) -> Vec<u8> {
    let mut wave = WAV.to_vec();
    for bytes in wave[WAV_HEADER_BYTES..].chunks_exact_mut(2) {
        let sample = i32::from(i16::from_le_bytes([bytes[0], bytes[1]]));
        let scaled = (sample * i32::from(volume) / 100) as i16;
        bytes.copy_from_slice(&scaled.to_le_bytes());
    }
    wave
}

#[cfg(all(windows, feature = "desktop"))]
pub(crate) fn play(volume: u8) {
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_MEMORY, SND_NODEFAULT};
    if volume == 0 {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let wave = scaled_chime(volume);
        // Synchronous playback on a worker keeps the buffer alive until playback finishes.
        unsafe {
            PlaySoundW(
                wave.as_ptr().cast(),
                std::ptr::null_mut(),
                SND_MEMORY | SND_NODEFAULT,
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_scales_pcm_samples_and_preserves_the_wav_header() {
        assert_eq!(&WAV[..4], b"RIFF");
        assert_eq!(&WAV[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([WAV[20], WAV[21]]), 1);
        assert_eq!(u16::from_le_bytes([WAV[34], WAV[35]]), 16);
        assert_eq!(&WAV[36..40], b"data");
        assert_eq!(scaled_chime(100), WAV);
        assert!(scaled_chime(0)[WAV_HEADER_BYTES..]
            .iter()
            .all(|byte| *byte == 0));
        let half = scaled_chime(50);
        assert_eq!(&half[..WAV_HEADER_BYTES], &WAV[..WAV_HEADER_BYTES]);
        for (original, quieter) in WAV[WAV_HEADER_BYTES..]
            .chunks_exact(2)
            .zip(half[WAV_HEADER_BYTES..].chunks_exact(2))
        {
            assert_eq!(
                i16::from_le_bytes([quieter[0], quieter[1]]),
                i16::from_le_bytes([original[0], original[1]]) / 2,
            );
        }
    }
}
