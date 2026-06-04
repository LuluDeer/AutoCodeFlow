from setuptools import setup, find_packages

setup(
    name="autoflow-sdk",
    version="0.1.0",
    description="AutoFlow Python SDK — base utilities for task execution",
    packages=find_packages(exclude=["tests*"]),
    python_requires=">=3.9",
    install_requires=[
        "httpx>=0.24.0",
        "pyyaml>=6.0",
    ],
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
    ],
)
