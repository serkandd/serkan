#!/usr/bin/env python3
"""
Araç marka/model, kasa tipi ve renk tanıma için CLIP (OpenAI ViT-B/32, MIT) sıfır-atış (zero-shot)
sınıflandırıcısını hazırlar.

- Görüntü kodlayıcı int8'e sıkıştırılır → public/models/vehicle-clip/visual-int8.onnx
- Etiketler (Türkiye pazarındaki araçlar, kasa tipleri, renkler) metin kodlayıcı ile önceden
  vektöre çevrilir → public/models/vehicle-clip/labels.json  (telefonda metin modeli gerekmez)

Listeye araç eklemek için MAKES sözlüğünü düzenleyip betiği yeniden çalıştırın:
  pip install onnxruntime open_clip_torch
  python scripts/build_vehicle_clip.py --visual jina_visual.onnx --textual jina_textual.onnx
Modeller: https://clip-as-service.s3.us-east-2.amazonaws.com/models-436c69702d61732d53657276696365/onnx/ViT-B-32/{visual,textual}.onnx
"""
import argparse, json, base64
from pathlib import Path
import numpy as np
import onnxruntime as ort
import open_clip
from onnxruntime.quantization import quantize_dynamic, QuantType

MAKES = {
    "Fiat": ["Egea", "Linea", "Doblo", "Fiorino", "Albea", "Palio", "Punto", "500", "Panda", "Tipo"],
    "Renault": ["Clio", "Megane", "Symbol", "Fluence", "Taliant", "Captur", "Kadjar", "Austral", "Kangoo", "Trafic", "Master", "Laguna", "Talisman"],
    "Dacia": ["Duster", "Sandero", "Logan", "Jogger", "Lodgy", "Dokker"],
    "Toyota": ["Corolla", "C-HR", "Yaris", "Auris", "RAV4", "Hilux", "Proace City", "Camry"],
    "Volkswagen": ["Passat", "Golf", "Polo", "Jetta", "Tiguan", "T-Roc", "Taigo", "Caddy", "Transporter", "Amarok", "Crafter", "T-Cross", "Arteon"],
    "Ford": ["Focus", "Fiesta", "Puma", "Kuga", "Transit Courier", "Transit Connect", "Transit", "Transit Custom", "Ranger", "Mondeo", "Tourneo Courier"],
    "Hyundai": ["i20", "i30", "Accent Blue", "Elantra", "Tucson", "Bayon", "Kona", "i10", "Santa Fe"],
    "Opel": ["Corsa", "Astra", "Insignia", "Mokka", "Crossland", "Grandland", "Combo", "Vectra"],
    "Peugeot": ["208", "2008", "301", "308", "3008", "5008", "508", "Partner", "Rifter", "Boxer"],
    "Citroen": ["C3", "C4", "C-Elysee", "C5 Aircross", "Berlingo", "C3 Aircross", "Jumper"],
    "Honda": ["Civic", "City", "Jazz", "CR-V", "HR-V", "Accord"],
    "Skoda": ["Octavia", "Superb", "Fabia", "Kamiq", "Karoq", "Kodiaq", "Scala"],
    "Seat": ["Leon", "Ibiza", "Arona", "Ateca"],
    "Cupra": ["Formentor", "Leon"],
    "BMW": ["3 Series", "5 Series", "1 Series", "X1", "X3", "X5", "4 Series", "7 Series"],
    "Mercedes-Benz": ["C-Class", "E-Class", "A-Class", "CLA", "GLA", "GLC", "S-Class", "Vito", "Sprinter", "Actros", "Travego", "Tourismo", "Citaro", "Conecto"],
    "Audi": ["A3", "A4", "A6", "Q3", "Q5", "Q7", "A5"],
    "Kia": ["Sportage", "Ceed", "Rio", "Picanto", "Stonic", "XCeed", "Sorento"],
    "Nissan": ["Qashqai", "Juke", "Micra", "Navara", "X-Trail"],
    "Togg": ["T10X"],
    "Chery": ["Tiggo 7 Pro", "Tiggo 8 Pro", "Omoda 5"],
    "MG": ["ZS", "HS", "MG4"],
    "BYD": ["Atto 3", "Seal", "Dolphin"],
    "Tesla": ["Model Y", "Model 3"],
    "Volvo": ["XC40", "XC60", "XC90", "S60", "S90", "FH"],
    "Suzuki": ["Vitara", "Swift"],
    "Mitsubishi": ["L200"],
    "Isuzu": ["D-Max", "NPR", "Novo"],
    "Iveco": ["Daily", "S-Way"],
    "MAN": ["TGX", "Lion's Coach"],
    "Scania": ["R-series truck"],
    "DAF": ["XF"],
    "Otokar": ["Sultan", "Kent", "Doruk"],
    "Karsan": ["Jest", "Atak", "e-Jest"],
    "Ford Trucks": ["F-Max", "Cargo"],
    "Anadol": ["A1"],
    "Tofaş": ["Şahin", "Doğan", "Kartal"],
    "Temsa": ["Prestij", "Avenue"],
    "BMC": ["Tugra", "Procity"],
    "Jeep": ["Renegade", "Compass"],
    "Land Rover": ["Range Rover", "Defender"],
    "Porsche": ["Cayenne", "Macan"],
    "Mazda": ["CX-5", "3"],
    "Subaru": ["Forester", "XV"],
    "Lada": ["Niva"],
}
TYPES = {
    "Sedan": "a sedan car", "Hatchback": "a hatchback car", "SUV": "an SUV", "Station wagon": "a station wagon car",
    "Pikap": "a pickup truck", "Hafif ticari (panelvan)": "a small commercial van", "Minibüs": "a minibus",
    "Otobüs": "a bus", "Kamyon": "a heavy truck", "Kamyonet": "a light truck", "Motosiklet": "a motorcycle",
    "Coupe / spor": "a sports coupe car",
}
COLORS = {
    "Beyaz": "white", "Siyah": "black", "Gri": "gray", "Gümüş": "silver", "Kırmızı": "red", "Mavi": "blue",
    "Lacivert": "dark blue", "Yeşil": "green", "Sarı": "yellow", "Turuncu": "orange", "Kahverengi": "brown",
    "Bej": "beige", "Bordo": "burgundy", "Mor": "purple",
}
MAKE_T = ["a photo of a {}.", "a photo of a {}, a type of car.", "a photo of my {}.", "a photo of the front of a {}.",
          "a photo of the back of a {}.", "a photo of a {} on the street.", "a blurry photo of a {}."]
TYPE_T = ["a photo of {}.", "a photo of {} on the road.", "a photo of the back of {}."]
COLOR_T = ["a photo of a {} car.", "a photo of a {} vehicle.", "a {} colored car."]

ap = argparse.ArgumentParser()
ap.add_argument("--visual", required=True)
ap.add_argument("--textual", required=True)
args = ap.parse_args()

tok = open_clip.get_tokenizer("ViT-B-32")
txt = ort.InferenceSession(args.textual)

def embed(texts):
    ids = tok(texts).numpy().astype(np.int32)
    mask = (ids != 0).astype(np.int32)
    e = txt.run(None, {"input_ids": ids, "attention_mask": mask})[0]
    return e / np.linalg.norm(e, axis=1, keepdims=True)

def classes(items, templates):
    out = []
    for key, text in items:
        e = embed([t.format(text) for t in templates]).mean(0)
        out.append((key, e / np.linalg.norm(e)))
    return out

make_items = [(f"{b}|{m}", f"{b} {m}") for b, ms in MAKES.items() for m in ms]
groups = {
    "make": classes(make_items, MAKE_T),
    "type": classes(list(TYPES.items()), TYPE_T),
    "color": classes(list(COLORS.items()), COLOR_T),
}

def pack(vecs):
    a = np.stack(vecs).astype(np.float16)
    return base64.b64encode(a.tobytes()).decode()

root = Path(__file__).resolve().parent.parent / "public/models/vehicle-clip"
root.mkdir(parents=True, exist_ok=True)
out = {"dim": 512, "logitScale": 100.0}
for g, items in groups.items():
    out[g] = {"labels": [k for k, _ in items], "embeddings_f16_b64": pack([v for _, v in items])}
(root / "labels.json").write_text(json.dumps(out, ensure_ascii=False))
quantize_dynamic(args.visual, str(root / "visual-int8.onnx"), weight_type=QuantType.QUInt8)
print("Hazır:", root, {g: len(v) for g, v in groups.items()})
