//! Spoken-language policy is separate from explicit output-language validation:
//! "auto" is a recognition choice, never a language to translate text into.
use crate::parakeet::models::AVAILABLE_MODELS;
use crate::whisper::languages::validate_language;

pub fn model_requires_english_speech(engine: &str, model_name: &str) -> bool {
    match engine {
        "whisper" => model_name.ends_with(".en"),
        "parakeet" => AVAILABLE_MODELS
            .iter()
            .find(|model| model.id == model_name)
            .map(|model| model.languages == ["en"])
            .unwrap_or_else(|| model_name.contains("-v2")),
        _ => false,
    }
}

pub fn supports_auto_speech_language(engine: &str, model_name: &str) -> bool {
    matches!(engine, "whisper" | "parakeet") && !model_requires_english_speech(engine, model_name)
}

pub fn normalize_speech_language_for_model(
    engine: &str,
    model_name: &str,
    speech_language: &str,
) -> String {
    if speech_language.trim() == "auto" && supports_auto_speech_language(engine, model_name) {
        return "auto".to_string();
    }
    let validated = validate_language(Some(speech_language));
    match engine {
        "whisper" if model_requires_english_speech(engine, model_name) => "en".to_string(),
        "parakeet" => {
            if let Some(definition) = AVAILABLE_MODELS.iter().find(|model| model.id == model_name) {
                if definition.languages.contains(&validated) {
                    validated.to_string()
                } else {
                    definition
                        .languages
                        .first()
                        .copied()
                        .unwrap_or("en")
                        .to_string()
                }
            } else if model_requires_english_speech(engine, model_name) {
                "en".to_string()
            } else {
                validated.to_string()
            }
        }
        "soniox" => {
            const SONIOX_SUPPORTED_LANGUAGES: &[&str] = &[
                "en", "es", "fr", "de", "it", "pt", "nl", "ru", "zh", "ja", "ko", "ar", "hi", "tr",
                "pl", "sv", "no", "da", "fi", "el", "cs", "ro", "hu", "sk", "uk", "he", "id", "vi",
                "th", "ms", "tl", "fa", "ur", "bn", "ta", "te", "gu", "pa", "bg", "hr", "sr", "sl",
                "lv", "lt", "et", "is", "ca", "gl",
            ];
            if SONIOX_SUPPORTED_LANGUAGES.contains(&validated) {
                validated.to_string()
            } else {
                "en".to_string()
            }
        }
        "cohere" => {
            const COHERE_SUPPORTED_LANGUAGES: &[&str] = &[
                "en", "de", "fr", "it", "es", "pt", "el", "nl", "pl", "vi", "zh", "ar", "ja", "ko",
            ];
            if COHERE_SUPPORTED_LANGUAGES.contains(&validated) {
                validated.to_string()
            } else {
                "en".to_string()
            }
        }
        _ => validated.to_string(),
    }
}
